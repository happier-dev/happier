import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import * as interactions from './interactions/index.public.js';

const PROTOCOL_INTERACTION_EXPORTS = [
    'InteractionTerminalStatusV1',
    'InteractionTransientApprovalAuthorRequestV1',
    'InteractionTransientApprovalResultV1',
    'InteractionTransientAuthorQuestionV1',
    'InteractionTransientAuthorRequestV1',
    'InteractionTransientChoiceSelectionV1',
    'InteractionTransientConfirmationAuthorRequestV1',
    'InteractionTransientConfirmationResultV1',
    'InteractionTransientQuestionAnswerV1',
    'InteractionTransientQuestionsAuthorRequestV1',
    'InteractionTransientQuestionsResultV1',
    'InteractionTransientResultV1',
] as const;

const RETIRED_LEGACY_NON_SESSION_EXPORTS = [
    'InteractionChoiceAnswer',
    'InteractionQuestion',
    'InteractionQuestionAnswer',
    'InteractionQuestionsResult',
] as const;

const PROHIBITED_RETIRED_INTERACTION_EXPORTS = [
    'InteractionApprovalRequest',
    'InteractionApprovalResult',
    'InteractionQuestionChoice',
] as const;

async function parseInteractionsSource(): Promise<ts.SourceFile> {
    const source = await readFile(new URL('./interactions.ts', import.meta.url), 'utf8');
    return ts.createSourceFile(
        'interactions.ts',
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
    );
}

function protocolTypeExports(source: ts.SourceFile): readonly string[] {
    return source.statements.flatMap((statement) => {
        if (!ts.isExportDeclaration(statement)
            || !statement.isTypeOnly
            || !statement.moduleSpecifier
            || !ts.isStringLiteral(statement.moduleSpecifier)
            || statement.moduleSpecifier.text !== '@happier-dev/protocol'
            || !statement.exportClause
            || !ts.isNamedExports(statement.exportClause)
        ) {
            return [];
        }
        return statement.exportClause.elements.map((element) => element.name.text);
    });
}

function localTypeExports(source: ts.SourceFile, moduleSpecifier: string): readonly string[] {
    return source.statements.flatMap((statement) => {
        if (!ts.isExportDeclaration(statement)
            || !statement.isTypeOnly
            || !statement.moduleSpecifier
            || !ts.isStringLiteral(statement.moduleSpecifier)
            || statement.moduleSpecifier.text !== moduleSpecifier
            || !statement.exportClause
            || !ts.isNamedExports(statement.exportClause)
        ) {
            return [];
        }
        return statement.exportClause.elements.map((element) => element.name.text);
    });
}

function interactionsMethod(
    source: ts.SourceFile,
    name: string,
): ts.MethodSignature {
    const declaration = source.statements.find((statement): statement is ts.InterfaceDeclaration => (
        ts.isInterfaceDeclaration(statement) && statement.name.text === 'InteractionsService'
    ));
    if (!declaration) throw new Error('Missing InteractionsService interface');
    const method = declaration.members.find((member): member is ts.MethodSignature => (
        ts.isMethodSignature(member) && ts.isIdentifier(member.name) && member.name.text === name
    ));
    if (!method) throw new Error(`Missing InteractionsService.${name}`);
    return method;
}

function typeText(source: ts.SourceFile, node: ts.TypeNode | undefined): string | undefined {
    return node?.getText(source);
}

describe('transient interaction public projection', () => {
    it('validates author questions through the public interaction domain without granting host custody fields', () => {
        expect(interactions.InteractionTransientAuthorRequestV1Schema).toBeDefined();
        const request = { kind: 'questions', title: 'Choose', questions: [
            { id: 'one', prompt: 'Which?', type: 'singleChoice', required: true,
                choices: [{ id: 'a', label: 'A' }] },
        ] };
        expect(interactions.InteractionTransientAuthorRequestV1Schema.safeParse(request).success).toBe(true);
        expect(interactions.InteractionTransientAuthorRequestV1Schema.safeParse({
            ...request, requestId: 'host-only',
        }).success).toBe(false);
        expect(interactions.InteractionTransientAuthorRequestV1Schema.safeParse({
            ...request, questions: [...request.questions, ...request.questions],
        }).success).toBe(false);
    });
    it('directly re-exports the Protocol author input and terminal result vocabulary', async () => {
        const source = await parseInteractionsSource();

        expect(protocolTypeExports(source)).toEqual(PROTOCOL_INTERACTION_EXPORTS);
    });

    it('publishes only the direct Protocol vocabulary and no retired question aliases', async () => {
        const barrel = ts.createSourceFile(
            'interactions/index.ts',
            await readFile(new URL('./interactions/index.public.ts', import.meta.url), 'utf8'),
            ts.ScriptTarget.Latest,
            true,
            ts.ScriptKind.TS,
        );
        const exported = localTypeExports(barrel, '../interactions.js');

        expect(exported).toEqual(expect.arrayContaining([...PROTOCOL_INTERACTION_EXPORTS]));
        for (const retired of [
            ...RETIRED_LEGACY_NON_SESSION_EXPORTS,
            ...PROHIBITED_RETIRED_INTERACTION_EXPORTS,
        ]) {
            expect(exported).not.toContain(retired);
        }
    });

    it('removes the Voice-only question compatibility contract while keeping askQuestions canonical', async () => {
        const source = await parseInteractionsSource();
        const raw = await readFile(new URL('./interactions.ts', import.meta.url), 'utf8');

        expect(raw).not.toContain('Temporary source compatibility ingress for the existing non-Session Voice caller.');
        for (const retired of RETIRED_LEGACY_NON_SESSION_EXPORTS) {
            expect(raw).not.toContain(`export type ${retired}`);
        }

        const method = interactionsMethod(source, 'askQuestions');
        expect(typeText(source, method.parameters[0]?.type)).toBe('InteractionTransientQuestionsAuthorRequestV1');
        expect(typeText(source, method.parameters[1]?.type)).toBe('InteractionOptions');
        expect(typeText(source, method.type)).toBe('Promise<InteractionTransientQuestionsResultV1>');
    });

    it('uses exact kind-specific Protocol requests and results for every transient method', async () => {
        const source = await parseInteractionsSource();
        const cases = [
            {
                name: 'requestApproval',
                request: 'InteractionTransientApprovalAuthorRequestV1',
                result: 'InteractionTransientApprovalResultV1',
            },
            {
                name: 'askQuestions',
                request: 'InteractionTransientQuestionsAuthorRequestV1',
                result: 'InteractionTransientQuestionsResultV1',
            },
            {
                name: 'confirm',
                request: 'InteractionTransientConfirmationAuthorRequestV1',
                result: 'InteractionTransientConfirmationResultV1',
            },
        ] as const;

        for (const expected of cases) {
            const method = interactionsMethod(source, expected.name);
            expect(method.parameters).toHaveLength(2);
            expect(typeText(source, method.parameters[0]?.type)).toBe(expected.request);
            expect(typeText(source, method.parameters[1]?.type)).toBe('InteractionOptions');
            expect(typeText(source, method.type)).toBe(`Promise<${expected.result}>`);
        }
    });
});
