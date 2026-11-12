import { expect, it } from 'vitest';

import { createManagedPluginSourceCustody } from '../lifecycle/contributions/runtimeIdentity.testkit';
import { createTargetActionHostBindingResolver } from '../hostAccess/resolve';
import { createTargetActionInvocationRegistry } from './targetActionRegistry';
import { createProductionPluginInvocationServiceOwners } from './services/production';
import type { PluginInvocationLogRecord } from './services/logger';

it('redacts a started mutation failure and plugin log after cancellation and retirement until completion', async () => {
    const secret = 'synthetic-cancelled-release-operand';
    const records: PluginInvocationLogRecord[] = [];
    const owners = createProductionPluginInvocationServiceOwners({
        loggerSink: { write: record => records.push(record) },
    });
    const caller = new AbortController();
    let releaseHandler!: () => void;
    const held = new Promise<void>(resolve => { releaseHandler = resolve; });
    let handlerStarted!: () => void;
    const started = new Promise<void>(resolve => { handlerStarted = resolve; });
    let scope: Parameters<typeof owners.beginDiagnosticScope>[0] | undefined;
    const registry = createTargetActionInvocationRegistry({
        ...owners,
        beginDiagnosticScope: (...args) => { scope = args[0]; owners.beginDiagnosticScope(...args); },
        resolveHostBinding: createTargetActionHostBindingResolver(),
        resolveAuthorizationFacts: resolvedAction => ({
            generation: {
                targetGeneration: resolvedAction.occurrenceId,
                desiredGeneration: resolvedAction.occurrenceId,
                appliedGeneration: resolvedAction.occurrenceId,
            },
            resourceSelections: [], scopedGrants: [], operatingSystemAuthorization: [],
        }),
        readCurrentPluginOccurrenceId: () => '7',
        actions: [{
            pluginId: 'acme.alpha', pluginVersion: '1.2.3', occurrenceId: '7', localId: 'run',
            sourceCustody: createManagedPluginSourceCustody('acme-alpha-generation-1'),
            definition: {
                id: 'run', dangerLevel: 'safe', scopes: ['global'], surfaces: ['cli'],
                readOnly: false, secretInputPaths: ['value'],
                inputSchema: { type: 'object', properties: { value: { type: 'string' } },
                    required: ['value'], additionalProperties: false },
                resultSchema: { type: 'null' },
            },
            handler: async (_input, context) => {
                context.services.logger.info(`Release started for ${secret} at public-endpoint`);
                handlerStarted();
                await held;
                expect(context.signal.aborted).toBe(true);
                const message = `Release failed for ${secret} at public-endpoint`;
                context.services.logger.error(message);
                throw new Error(message);
            },
        }],
    });
    const invocation = registry.invoke({
        pluginId: 'acme.alpha', localId: 'run', input: { value: secret },
        surface: 'cli', signal: caller.signal,
    });
    try {
        await started;
        caller.abort(new Error('caller stopped'));
        if (!scope) throw new Error('Missing invocation diagnostic scope');
        expect.soft(owners.redactDiagnosticText(scope, secret)).toBe('[REDACTED]');
        await owners.retireGeneration('7', 'acme.alpha');
        expect.soft(owners.redactDiagnosticText(scope, secret)).toBe('[REDACTED]');
        releaseHandler();
        const result = await invocation;
        expect(result).toMatchObject({ status: 'failed' });
        expect.soft(JSON.stringify(result)).not.toContain(secret);
        expect.soft(JSON.stringify(records)).not.toContain(secret);
        expect(JSON.stringify(result)).toContain('public-endpoint');
        expect(JSON.stringify(records)).toContain('public-endpoint');
        expect(JSON.stringify(result)).toContain('[REDACTED]');
        expect(JSON.stringify(records)).toContain('[REDACTED]');
        // Cancelled contexts suppress late log writes; the retained failure still settles.
        expect(records).toHaveLength(1);
        expect(records[0]?.message).toBe('Release started for [REDACTED] at public-endpoint');
        expect(owners.redactDiagnosticText(scope, secret)).toBe(secret);
    } finally {
        releaseHandler();
        await invocation;
        registry.dispose();
        await owners.dispose();
    }
});
