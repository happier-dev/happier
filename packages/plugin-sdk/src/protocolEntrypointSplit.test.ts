import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

import { describe, expect, expectTypeOf, it } from 'vitest';
import ts from 'typescript';
import type * as UiPackage from './ui/index.js';
import type * as UiPublic from './ui/index.public.js';
import type * as UiBrowser from './ui.js';
import type { ActionConfirmationInputField as ActionField } from './actions/index.js';
import type { ActionConfirmationInputField as PublicActionField } from './actions/index.public.js';
import type { PluginActionConfirmationInputFieldV2 } from '@happier-dev/protocol/plugins/actions/v2';
import * as nodeProtocol from './protocol/index.js';
import * as browserProtocol from './protocol/index.browser.js';

const require = createRequire(import.meta.url);

async function readSource(path: string): Promise<string> {
    return readFile(new URL(path, import.meta.url), 'utf8');
}

describe('SDK protocol entrypoint cut', () => {
    it('publishes SCM identity and summary types only through the SCM domain', async () => {
        const owners = new Map<string, string[]>();
        for (const domain of ['protocol', 'scm']) {
            const path = `./${domain}/index.public.ts`;
            const source = ts.createSourceFile(path, await readSource(path), ts.ScriptTarget.Latest, true);
            for (const statement of source.statements) {
                if (!ts.isExportDeclaration(statement) || !statement.exportClause || !ts.isNamedExports(statement.exportClause)) continue;
                for (const element of statement.exportClause.elements) {
                    const name = element.name.text;
                    owners.set(name, [...(owners.get(name) ?? []), domain]);
                }
            }
        }
        for (const name of ['ProtocolScmHostingProviderKind', 'ScmHostingRepositoryIdentityV1', 'ScmPullRequestSummary']) {
            expect(owners.get(name), name).toEqual(['scm']);
        }
    });
    it('exposes the canonical reviewed Action operand through the shared Node/browser Actions barrel', () => {
        expectTypeOf<ActionField>().toEqualTypeOf<PublicActionField>();
        expectTypeOf<ActionField>().toEqualTypeOf<PluginActionConfirmationInputFieldV2>();
    });
    it('projects the qualified Machine read types through every UI author barrel', () => {
        expectTypeOf<UiPackage.ReadMachineDisplayNameRequest>().toEqualTypeOf<UiPublic.ReadMachineDisplayNameRequest>();
        expectTypeOf<UiPackage.ReadMachineDisplayNameResult>().toEqualTypeOf<UiPublic.ReadMachineDisplayNameResult>();
        expectTypeOf<UiPackage.ReadMachineDisplayNameRequest>().toEqualTypeOf<UiBrowser.ReadMachineDisplayNameRequest>();
        expectTypeOf<UiPackage.ReadMachineDisplayNameResult>().toEqualTypeOf<UiBrowser.ReadMachineDisplayNameResult>();
        expectTypeOf<UiPackage.PluginUiHostApi['readMachineDisplayName']>().toEqualTypeOf<UiPublic.PluginUiHostApi['readMachineDisplayName']>();
    });
    it('publishes disjoint protocol and contribution author surfaces and retires protocol-authoring', async () => {
        const packageJson = JSON.parse(
            await readFile(new URL('../package.json', import.meta.url), 'utf8'),
        ) as Readonly<{ exports: Readonly<Record<string, unknown>> }>;

        expect(packageJson.exports['./protocol']).toMatchObject({
            types: './dist/protocol/index.d.ts',
            browser: {
                'happier-source': './src/protocol/index.browser.ts',
                default: './dist/protocol/index.browser.js',
            },
            default: './dist/protocol/index.js',
        });
        expect(packageJson.exports['./contributions']).toMatchObject({
            types: './dist/contributions/index.d.ts',
            browser: {
                'happier-source': './src/contributions/index.browser.ts',
                default: './dist/contributions/index.browser.js',
            },
            default: './dist/contributions/index.js',
        });
        expect(packageJson.exports['./protocol-authoring']).toBeUndefined();

        await expect(readSource('./protocol/index.ts')).resolves.toBeTruthy();
        await expect(readSource('./protocol/index.browser.ts')).resolves.toBeTruthy();
        await expect(readSource('./protocol/index.public.ts')).resolves.toBeTruthy();
        await expect(readSource('./contributions/index.ts')).resolves.toBeTruthy();
        await expect(readSource('./contributions/index.browser.ts')).resolves.toBeTruthy();
        await expect(readSource('./contributions/index.public.ts')).resolves.toBeTruthy();
        await expect(readSource('./protocol-authoring/index.ts')).rejects.toMatchObject({
            code: 'ENOENT',
        });

        const protocolSource = await readSource('./protocol/index.ts');
        const contributionsSource = await readSource('./contributions/index.ts');
        expect(protocolSource).not.toContain('defineContributionProtocol');
        expect(protocolSource).not.toContain('ContributionSurface');
        expect(contributionsSource).not.toContain('defineProtocolObject');
        expect(contributionsSource).not.toContain('ProtocolComposableSchema');
        expect(() => require.resolve('@happier-dev/plugin-sdk/protocol-authoring')).toThrow();
    });

    it('gives browser bundles the same protocol runtime exports as Node', () => {
        // Browser plugin UI artifacts resolve `@happier-dev/plugin-sdk/protocol`
        // through the browser condition; an export missing there fails their build.
        // Load the real modules during collection; source transformation time
        // is setup work rather than the runtime export-comparison contract.
        expect(Object.keys(browserProtocol).sort()).toEqual(Object.keys(nodeProtocol).sort());
    });
});
