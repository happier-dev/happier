import { readFile } from 'node:fs/promises';

import { describe, expect, expectTypeOf, it } from 'vitest';
import ts from 'typescript';

import {
    AutomationIdV1Schema as canonicalAutomationIdV1Schema,
    AutomationConversationAdmitInputV1Schema as canonicalAutomationConversationAdmitInputV1Schema,
    AutomationConversationAdmitResultV1Schema as canonicalAutomationConversationAdmitResultV1Schema,
    AutomationConversationResultDeliveryV1Schema as canonicalAutomationConversationResultDeliveryV1Schema,
    AutomationResultDeliveryInputV1JsonSchema as canonicalAutomationResultDeliveryInputV1JsonSchema,
    AutomationResultDeliveryInputV1Schema as canonicalAutomationResultDeliveryInputV1Schema,
    AutomationResultDeliveryResultV1JsonSchema as canonicalAutomationResultDeliveryResultV1JsonSchema,
    AutomationResultDeliveryResultV1Schema as canonicalAutomationResultDeliveryResultV1Schema,
    AutomationResultDeliverySourceV1JsonSchema as canonicalAutomationResultDeliverySourceV1JsonSchema,
    AutomationResultDeliverySourceV1Schema as canonicalAutomationResultDeliverySourceV1Schema,
} from '@happier-dev/protocol/automations/result-delivery';
import type {
    AutomationIdV1 as CanonicalAutomationIdV1,
    AutomationConversationAdmitInputV1 as CanonicalAutomationConversationAdmitInputV1,
    AutomationConversationAdmitResultV1 as CanonicalAutomationConversationAdmitResultV1,
    AutomationConversationResultDeliveryV1 as CanonicalAutomationConversationResultDeliveryV1,
    AutomationResultDeliveryInputV1 as CanonicalAutomationResultDeliveryInputV1,
    AutomationResultDeliveryResultV1 as CanonicalAutomationResultDeliveryResultV1,
    AutomationResultDeliverySourceV1 as CanonicalAutomationResultDeliverySourceV1,
} from '@happier-dev/protocol/automations/result-delivery';

import type {
    AutomationIdV1,
    AutomationConversationAdmitInputV1,
    AutomationConversationAdmitResultV1,
    AutomationConversationResultDeliveryV1,
    AutomationResultDeliveryInputV1,
    AutomationResultDeliveryResultV1,
    AutomationResultDeliverySourceV1,
} from './automations/index.js';
import type { ProtocolComposableSchema } from './protocol/protocolFacade.js';

const source = {
    kind: 'automationResult',
    automationRunId: 'run-1',
    resultId: 'handoff-1',
    automationId: 'automation-1',
    templateVersion: 3,
    resultDelivery: 'finalResult',
} as const;

const input = {
    v: 1,
    handoffId: 'handoff-1',
    runId: 'run-1',
    automationId: 'automation-1',
    source,
    result: { v: 1, kind: 'text', text: 'Completed.' },
    opaqueContext: { route: 'channels' },
} as const;

/**
 * A synthetic out-of-tree bridge. The public automations surface names no
 * plugin, so any plugin may declare itself the reply-delivery target.
 */
const thirdPartyDeliveryActionRef = {
    pluginId: 'acme.slack-bridge',
    localId: 'automation/reply-deliver-v1',
} as const;

const conversationAdmissionInput = {
    automationId: 'automation-1',
    bindingId: 'binding-1',
    templateVersion: 3,
    occurrenceId: 'occurrence-1',
    occurredAt: 1,
    sender: {
        principalId: 'principal-1',
        kind: 'human',
        isIntegrationSelf: false,
        contentProvenance: 'original',
    },
    text: 'Start the automation.',
    resultDelivery: { kind: 'none' },
} as const;

describe('Automation result-delivery public projection', () => {
    it('declares the realm-neutral /automations package subpath', async () => {
        const packageJson = JSON.parse(
            await readFile(new URL('../package.json', import.meta.url), 'utf8'),
        ) as Readonly<{ exports: Readonly<Record<string, unknown>> }>;

        expect(packageJson.exports['./automations']).toEqual({
            types: './dist/automations/index.d.ts',
            default: './dist/automations/index.js',
        });
        expect((await readFile(new URL('./automations.ts', import.meta.url), 'utf8'))
            .startsWith('/** @moduleRealm any */')).toBe(true);
        expect(await readFile(new URL('./automations.ts', import.meta.url), 'utf8'))
            .toContain("from '@happier-dev/protocol/automations/result-delivery'");
    });

    it('reexports the exact strict Protocol schemas and types', async () => {
        const publicAutomations = await import('./automations/index.js');

        expect(publicAutomations.AutomationResultDeliverySourceV1Schema)
            .toBe(canonicalAutomationResultDeliverySourceV1Schema);
        expect(publicAutomations.AutomationResultDeliveryInputV1Schema)
            .toBe(canonicalAutomationResultDeliveryInputV1Schema);
        expect(publicAutomations.AutomationResultDeliveryResultV1Schema)
            .toBe(canonicalAutomationResultDeliveryResultV1Schema);
        expect(publicAutomations.AutomationResultDeliverySourceV1JsonSchema)
            .toBe(canonicalAutomationResultDeliverySourceV1JsonSchema);
        expect(publicAutomations.AutomationResultDeliveryInputV1JsonSchema)
            .toBe(canonicalAutomationResultDeliveryInputV1JsonSchema);
        expect(publicAutomations.AutomationResultDeliveryResultV1JsonSchema)
            .toBe(canonicalAutomationResultDeliveryResultV1JsonSchema);
        expect(publicAutomations.AutomationConversationResultDeliveryV1Schema)
            .toBe(canonicalAutomationConversationResultDeliveryV1Schema);
        expect(publicAutomations.AutomationConversationAdmitInputV1Schema)
            .toBe(canonicalAutomationConversationAdmitInputV1Schema);
        expect(publicAutomations.AutomationConversationAdmitResultV1Schema)
            .toBe(canonicalAutomationConversationAdmitResultV1Schema);
        expect(publicAutomations.AutomationIdV1Schema)
            .toBe(canonicalAutomationIdV1Schema);

        expect(publicAutomations.AutomationResultDeliverySourceV1Schema.safeParse(source).success)
            .toBe(true);
        expect(publicAutomations.AutomationResultDeliverySourceV1Schema.safeParse({
            ...source,
            unexpected: true,
        }).success).toBe(false);
        expect(publicAutomations.AutomationResultDeliveryInputV1Schema.safeParse(input).success)
            .toBe(true);
        expect(publicAutomations.AutomationResultDeliveryInputV1Schema.safeParse({
            ...input,
            unexpected: true,
        }).success).toBe(false);
        expect(publicAutomations.AutomationResultDeliveryResultV1Schema.safeParse({
            kind: 'accepted',
            custodyId: 'custody-1',
            unexpected: true,
        }).success).toBe(false);
        expect(publicAutomations.AutomationResultDeliveryResultV1Schema.safeParse({
            kind: 'retired',
        }).success).toBe(true);
        expect(publicAutomations.AutomationConversationResultDeliveryV1Schema.safeParse({
            kind: 'finalResult',
            actionRef: thirdPartyDeliveryActionRef,
            opaqueContext: { route: 'slack' },
        }).success).toBe(true);
        expect(publicAutomations.AutomationConversationResultDeliveryV1Schema.safeParse({
            kind: 'finalResult',
            actionRef: thirdPartyDeliveryActionRef,
            opaqueContext: { route: 'slack' },
            unexpected: true,
        }).success).toBe(false);
        expect(publicAutomations.AutomationConversationAdmitInputV1Schema
            .safeParse(conversationAdmissionInput).success).toBe(true);
        expect(publicAutomations.AutomationConversationAdmitInputV1Schema.safeParse({
            ...conversationAdmissionInput,
            unexpected: true,
        }).success).toBe(false);
        expect(publicAutomations.AutomationConversationAdmitResultV1Schema.safeParse({
            kind: 'admitted',
            runId: 'run-1',
            checkpointSafe: true,
            unexpected: true,
        }).success).toBe(false);
        expect(publicAutomations.AutomationIdV1Schema.safeParse('automation-1').success).toBe(true);
        expect(publicAutomations.AutomationIdV1Schema.safeParse(' automation-1 ').success).toBe(false);

        expectTypeOf<AutomationResultDeliverySourceV1>()
            .toEqualTypeOf<CanonicalAutomationResultDeliverySourceV1>();
        expectTypeOf<AutomationResultDeliveryInputV1>()
            .toEqualTypeOf<CanonicalAutomationResultDeliveryInputV1>();
        expectTypeOf<AutomationResultDeliveryResultV1>()
            .toEqualTypeOf<CanonicalAutomationResultDeliveryResultV1>();
        expectTypeOf<AutomationConversationResultDeliveryV1>()
            .toEqualTypeOf<CanonicalAutomationConversationResultDeliveryV1>();
        expectTypeOf<AutomationConversationAdmitInputV1>()
            .toEqualTypeOf<CanonicalAutomationConversationAdmitInputV1>();
        expectTypeOf<AutomationConversationAdmitResultV1>()
            .toEqualTypeOf<CanonicalAutomationConversationAdmitResultV1>();
        expectTypeOf<AutomationIdV1>().toEqualTypeOf<CanonicalAutomationIdV1>();
        expectTypeOf<typeof publicAutomations.AutomationIdV1Schema>()
            .toMatchTypeOf<ProtocolComposableSchema<AutomationIdV1>>();
    });

    it('reexports the canonical Automation identity schema without an SDK-local declaration alias', async () => {
        const sourceText = await readFile(new URL('./automations.ts', import.meta.url), 'utf8');
        const emitted = ts.transpileDeclaration(sourceText, {
            fileName: 'automations.ts',
            compilerOptions: {
                module: ts.ModuleKind.NodeNext,
                moduleResolution: ts.ModuleResolutionKind.NodeNext,
                target: ts.ScriptTarget.ES2022,
            },
            reportDiagnostics: true,
        });

        expect(emitted.diagnostics).toEqual([]);
        expect(emitted.outputText).toContain(
            'export { AutomationIdV1Schema, } from \'@happier-dev/protocol/automations/result-delivery\';',
        );
        expect(emitted.outputText).not.toContain('AutomationIdV1Schema:');
        expect(emitted.outputText).not.toMatch(/\b(?:Zod|_zod)\b/u);
    });
});
