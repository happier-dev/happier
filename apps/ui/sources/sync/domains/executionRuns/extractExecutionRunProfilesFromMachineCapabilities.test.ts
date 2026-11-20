import { describe, expect, it } from 'vitest';
import type { PluginJsonSchemaV2 } from '@happier-dev/protocol/plugins/contributions/jsonSchema';

import { resolveExecutionRunLauncherProfileChoices } from '@/components/sessions/runs/launcher/resolveExecutionRunLauncherProfileChoices';
import { extractExecutionRunProfilesFromMachineCapabilitiesState, resolveExecutionRunsCapabilityRead } from './extractExecutionRunsBackendsFromMachineCapabilities';

describe('extractExecutionRunProfilesFromMachineCapabilitiesState', () => {
    it('preserves declared option controls in the launcher profile choice', () => {
        const optionsSchema = {
            type: 'object',
            additionalProperties: false,
            properties: {
                configFiles: { type: 'array', items: { type: 'string' } },
                gate: { type: 'string', enum: ['critical', 'major', 'minor', 'trivial', 'info'], default: 'major' },
            },
        } satisfies PluginJsonSchemaV2;
        const optionsInputHints = { fields: [{ path: 'gate', title: 'Severity', widget: 'select',
            options: [{ value: 'major', label: 'Major' }] }] } as const;
        const profiles = extractExecutionRunProfilesFromMachineCapabilitiesState({
            snapshot: { response: { results: { 'tool.executionRuns': { ok: true, data: {
                executionRunProfiles: [{
                    id: 'review.coderabbit/review',
                    intent: 'review',
                    title: 'CodeRabbit Review',
                    compatibleAgents: ['coderabbit'],
                    sourceCustody: { kind: 'managed', immutableGenerationId: 'generation-3', installSource: 'archive' },
                    available: true,
                    defaults: { retention: 'resumable', runClass: 'bounded', io: 'streaming' },
                    optionsSchema,
                    optionsInputHints,
                }],
            } } } } },
        });

        expect(resolveExecutionRunLauncherProfileChoices({
            intent: 'review',
            profiles,
            backendChoices: [{ backendId: 'coderabbit', disabled: false }],
        })).toEqual([expect.objectContaining({ optionsSchema, optionsInputHints, compatibleAgentId: 'coderabbit', disabled: false })]);
    });

    it('accepts only qualified profiles with canonical source custody', () => {
        const profiles = extractExecutionRunProfilesFromMachineCapabilitiesState({
            snapshot: { response: { results: { 'tool.executionRuns': { ok: true, data: {
                executionRunProfiles: [
                    {
                        id: 'review.coderabbit/review',
                        intent: 'review',
                        title: { key: 'profile.review', fallback: 'CodeRabbit Review' },
                        compatibleAgents: ['coderabbit'],
                        sourceCustody: { kind: 'managed', immutableGenerationId: 'generation-3', installSource: 'archive' },
                        available: true,
                        defaults: { retention: 'resumable', runClass: 'bounded', io: 'streaming' },
                    },
                    { id: 'local-only', intent: 'review', sourceCustody: { kind: 'managed', immutableGenerationId: 'generation-3', installSource: 'archive' } },
                    { id: 'review.deepsec/audit', intent: 'review' },
                ],
            } } } } },
        });

        expect(profiles).toEqual([{
            id: 'review.coderabbit/review',
            intent: 'review',
            title: 'CodeRabbit Review',
            compatibleAgentIds: ['coderabbit'],
            sourceCustody: { kind: 'managed', immutableGenerationId: 'generation-3', installSource: 'archive' },
            available: true,
            defaults: { retention: 'resumable', runClass: 'bounded', io: 'streaming' },
        }]);
    });
});

describe('resolveExecutionRunsCapabilityRead', () => {
    const answered = { backends: { claude: { available: true, intents: ['review'] } } };
    const loaded = (entry: unknown) => ({ status: 'loaded', snapshot: { response: { results: { 'tool.executionRuns': entry } } } });

    it('reads an unanswered Machine as reading or unreadable, never as a refusal', () => {
        expect(resolveExecutionRunsCapabilityRead({ status: 'idle' })).toBe('reading');
        expect(resolveExecutionRunsCapabilityRead({ status: 'loading' })).toBe('reading');
        expect(resolveExecutionRunsCapabilityRead({ status: 'error' })).toBe('unreadable');
        expect(resolveExecutionRunsCapabilityRead(loaded({ ok: false, error: { message: 'boom' } }))).toBe('unreadable');
    });

    it('treats a reported backend map, or a Machine without the capability, as answered', () => {
        expect(resolveExecutionRunsCapabilityRead(loaded({ ok: true, data: answered }))).toBe('answered');
        expect(resolveExecutionRunsCapabilityRead({ status: 'error', snapshot: { response: { results: { 'tool.executionRuns': { ok: true, data: answered } } } } })).toBe('answered');
        expect(resolveExecutionRunsCapabilityRead({ status: 'not-supported' })).toBe('answered');
    });
});
