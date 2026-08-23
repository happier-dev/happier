import { describe, expect, it } from 'vitest';

import {
    MAX_TRIAGE_AGENT_TARGET_KEY_LENGTH_V1,
    MAX_TRIAGE_MODEL_ID_LENGTH_V1,
    MAX_TRIAGE_PROVIDER_CONNECTION_ID_LENGTH_V1,
    TRIAGE_AGENT_SELECTION_SETTING_ID_V1,
    TRIAGE_NO_AGENT_SELECTIONS_V1,
    mutateTriageAgentSelection,
    parseTriageAgentSelections,
    readTriageAgentSelections,
} from './agentSelection.js';
import { createTestkitAccountSettings } from './testkit/accountSettings.test-support.js';

const CLAUDE_KEY = 'agent:happier.claude/claude';
const CODEX_KEY = 'agent:happier.codex/codex';

function storedSelection(overrides: Readonly<Record<string, unknown>> = {}) {
    return { agentTargetKey: CLAUDE_KEY, model: null, ...overrides };
}

function storedValue(overrides: Readonly<Record<string, unknown>> = {}) {
    return { v: 1, ask: null, fix: null, ...overrides };
}

function deps(fixture: ReturnType<typeof createTestkitAccountSettings>) {
    return { settings: fixture.settings };
}

describe('parseTriageAgentSelections', () => {
    it('reads an absent value as "no agent chosen", not as a default agent', () => {
        // The whole point of the feature: unset must reach the caller as unset,
        // so the generic new-session flow keeps choosing. A parser that
        // invented an agent here would silently route every Ask and Fix at
        // whichever agent it picked.
        expect(parseTriageAgentSelections(undefined)).toEqual({
            kind: 'absent',
            value: TRIAGE_NO_AGENT_SELECTIONS_V1,
        });
        expect(parseTriageAgentSelections(null)).toEqual({
            kind: 'absent',
            value: TRIAGE_NO_AGENT_SELECTIONS_V1,
        });
        expect(TRIAGE_NO_AGENT_SELECTIONS_V1).toEqual({ v: 1, ask: null, fix: null });
    });

    it('reports a stored value it cannot read instead of silently becoming the default', () => {
        const unreadable = parseTriageAgentSelections(storedValue({ v: 2 }));
        expect(unreadable.kind).toBe('unreadable');
        expect(unreadable.value).toEqual(TRIAGE_NO_AGENT_SELECTIONS_V1);
    });

    it('refuses a value carrying a member this build does not know', () => {
        expect(parseTriageAgentSelections({ ...storedValue(), review: null }).kind).toBe('unreadable');
        expect(parseTriageAgentSelections({
            ...storedValue({ ask: { ...storedSelection(), permissionMode: 'yolo' } }),
        }).kind).toBe('unreadable');
    });

    it('reads one chosen agent per intent independently', () => {
        const read = parseTriageAgentSelections(storedValue({
            ask: storedSelection(),
            fix: storedSelection({ agentTargetKey: CODEX_KEY }),
        }));

        expect(read.kind).toBe('parsed');
        expect(read.value.ask).toEqual({ agentTargetKey: CLAUDE_KEY, model: null });
        expect(read.value.fix).toEqual({ agentTargetKey: CODEX_KEY, model: null });
    });

    it('reads the chosen model exactly as the canonical selection carries it', () => {
        const read = parseTriageAgentSelections(storedValue({
            ask: storedSelection({
                model: { modelId: 'claude-opus-4-8', providerConnectionId: null, updatedAt: 1700 },
            }),
        }));

        expect(read.kind).toBe('parsed');
        expect(read.value.ask?.model).toEqual({
            modelId: 'claude-opus-4-8',
            providerConnectionId: null,
            updatedAt: 1700,
        });
    });

    it('keeps a connection-bound model bound to its connection', () => {
        const read = parseTriageAgentSelections(storedValue({
            fix: storedSelection({
                model: { modelId: 'gpt-5', providerConnectionId: 'conn-1', updatedAt: 12 },
            }),
        }));

        expect(read.value.fix?.model?.providerConnectionId).toBe('conn-1');
    });

    it.each([
        ['an empty agent target key', storedSelection({ agentTargetKey: '' })],
        ['an untrimmed agent target key', storedSelection({ agentTargetKey: ` ${CLAUDE_KEY}` })],
        ['a control character in the agent target key', storedSelection({ agentTargetKey: `${CLAUDE_KEY}\u0007` })],
        ['a reserved record key', storedSelection({ agentTargetKey: '__proto__' })],
        ['an over-long agent target key', storedSelection({
            agentTargetKey: 'a'.repeat(MAX_TRIAGE_AGENT_TARGET_KEY_LENGTH_V1 + 1),
        })],
        ['a non-string agent target key', storedSelection({ agentTargetKey: 7 })],
        ['a model id carrying whitespace', storedSelection({
            model: { modelId: 'claude opus', providerConnectionId: null, updatedAt: 1 },
        })],
        ['an over-long model id', storedSelection({
            model: {
                modelId: 'a'.repeat(MAX_TRIAGE_MODEL_ID_LENGTH_V1 + 1),
                providerConnectionId: null,
                updatedAt: 1,
            },
        })],
        ['an over-long provider connection id', storedSelection({
            model: {
                modelId: 'gpt-5',
                providerConnectionId: 'a'.repeat(MAX_TRIAGE_PROVIDER_CONNECTION_ID_LENGTH_V1 + 1),
                updatedAt: 1,
            },
        })],
        ['a non-finite model timestamp', storedSelection({
            model: { modelId: 'gpt-5', providerConnectionId: null, updatedAt: Number.POSITIVE_INFINITY },
        })],
        ['a negative model timestamp', storedSelection({
            model: { modelId: 'gpt-5', providerConnectionId: null, updatedAt: -1 },
        })],
        ['a model with no agent', { agentTargetKey: null, model: { modelId: 'gpt-5', providerConnectionId: null, updatedAt: 1 } }],
    ])('refuses %s rather than dropping the member', (_label, ask) => {
        expect(parseTriageAgentSelections(storedValue({ ask })).kind).toBe('unreadable');
    });
});

describe('readTriageAgentSelections', () => {
    it('reads the stored value and the record revision it was read at', async () => {
        const fixture = createTestkitAccountSettings();
        fixture.seed(TRIAGE_AGENT_SELECTION_SETTING_ID_V1, storedValue({ ask: storedSelection() }));

        const read = await readTriageAgentSelections(deps(fixture));

        expect(read.kind).toBe('parsed');
        expect(read.value.ask?.agentTargetKey).toBe(CLAUDE_KEY);
        expect(read.revision).toBe(fixture.revision());
    });
});

describe('mutateTriageAgentSelection', () => {
    it('stores one intent without disturbing the other', async () => {
        // The destructive case this pins: writing Ask must leave a Fix choice
        // the user already made exactly where it was.
        const fixture = createTestkitAccountSettings();
        fixture.seed(TRIAGE_AGENT_SELECTION_SETTING_ID_V1, storedValue({
            fix: storedSelection({
                agentTargetKey: CODEX_KEY,
                model: { modelId: 'gpt-5', providerConnectionId: null, updatedAt: 99 },
            }),
        }));

        const result = await mutateTriageAgentSelection(deps(fixture), {
            kind: 'set',
            intent: 'ask',
            agentTargetKey: CLAUDE_KEY,
            model: null,
        });

        expect(result.status).toBe('applied');
        expect(fixture.read(TRIAGE_AGENT_SELECTION_SETTING_ID_V1)).toEqual({
            v: 1,
            ask: { agentTargetKey: CLAUDE_KEY, model: null },
            fix: {
                agentTargetKey: CODEX_KEY,
                model: { modelId: 'gpt-5', providerConnectionId: null, updatedAt: 99 },
            },
        });
    });

    it('clears only the named intent', async () => {
        const fixture = createTestkitAccountSettings();
        fixture.seed(TRIAGE_AGENT_SELECTION_SETTING_ID_V1, storedValue({
            ask: storedSelection(),
            fix: storedSelection({ agentTargetKey: CODEX_KEY }),
        }));

        const result = await mutateTriageAgentSelection(deps(fixture), { kind: 'clear', intent: 'fix' });

        expect(result.status).toBe('applied');
        expect(fixture.read(TRIAGE_AGENT_SELECTION_SETTING_ID_V1)).toEqual({
            v: 1,
            ask: { agentTargetKey: CLAUDE_KEY, model: null },
            fix: null,
        });
    });

    it('replaces the model only when the caller says so', async () => {
        const fixture = createTestkitAccountSettings();
        fixture.seed(TRIAGE_AGENT_SELECTION_SETTING_ID_V1, storedValue({
            ask: storedSelection({
                model: { modelId: 'claude-opus-4-8', providerConnectionId: null, updatedAt: 5 },
            }),
        }));

        const kept = await mutateTriageAgentSelection(deps(fixture), {
            kind: 'set',
            intent: 'ask',
            agentTargetKey: CLAUDE_KEY,
            model: { modelId: 'claude-haiku', providerConnectionId: null, updatedAt: 6 },
        });
        expect(kept.status).toBe('applied');
        expect(fixture.read(TRIAGE_AGENT_SELECTION_SETTING_ID_V1)).toMatchObject({
            ask: { model: { modelId: 'claude-haiku', updatedAt: 6 } },
        });

        const dropped = await mutateTriageAgentSelection(deps(fixture), {
            kind: 'set',
            intent: 'ask',
            agentTargetKey: CLAUDE_KEY,
            model: null,
        });
        expect(dropped.status).toBe('applied');
        expect(fixture.read(TRIAGE_AGENT_SELECTION_SETTING_ID_V1)).toEqual({
            v: 1,
            ask: { agentTargetKey: CLAUDE_KEY, model: null },
            fix: null,
        });
    });

    it('rejects a selection the canonical Session contract would refuse, and writes nothing', async () => {
        const fixture = createTestkitAccountSettings();

        const rejected = await mutateTriageAgentSelection(deps(fixture), {
            kind: 'set',
            intent: 'ask',
            agentTargetKey: ` ${CLAUDE_KEY}`,
            model: null,
        });

        expect(rejected).toEqual({ status: 'rejected', reason: 'agentTargetKey' });
        expect(fixture.setCallCount()).toBe(0);
        expect(fixture.read(TRIAGE_AGENT_SELECTION_SETTING_ID_V1)).toBeUndefined();
    });

    it('rejects a model id the canonical model contract would refuse', async () => {
        const fixture = createTestkitAccountSettings();

        const rejected = await mutateTriageAgentSelection(deps(fixture), {
            kind: 'set',
            intent: 'fix',
            agentTargetKey: CLAUDE_KEY,
            model: { modelId: 'claude opus', providerConnectionId: null, updatedAt: 1 },
        });

        expect(rejected).toEqual({ status: 'rejected', reason: 'modelId' });
        expect(fixture.setCallCount()).toBe(0);
    });

    it('declines to overwrite a stored value it cannot read', async () => {
        const fixture = createTestkitAccountSettings();
        fixture.seed(TRIAGE_AGENT_SELECTION_SETTING_ID_V1, { v: 2, ask: null, fix: null });

        const result = await mutateTriageAgentSelection(deps(fixture), {
            kind: 'set',
            intent: 'ask',
            agentTargetKey: CLAUDE_KEY,
            model: null,
        });

        expect(result).toEqual({ status: 'unreadable' });
        expect(fixture.setCallCount()).toBe(0);
        expect(fixture.read(TRIAGE_AGENT_SELECTION_SETTING_ID_V1)).toEqual({ v: 2, ask: null, fix: null });
    });

    it('reports the losing side of a concurrent write as a conflict instead of forcing its value', async () => {
        const fixture = createTestkitAccountSettings();
        fixture.armConcurrentWrite(TRIAGE_AGENT_SELECTION_SETTING_ID_V1, storedValue({
            ask: storedSelection({ agentTargetKey: CODEX_KEY }),
        }));

        const result = await mutateTriageAgentSelection(deps(fixture), {
            kind: 'set',
            intent: 'ask',
            agentTargetKey: CLAUDE_KEY,
            model: null,
        });

        expect(result).toEqual({ status: 'conflict' });
        expect(fixture.read(TRIAGE_AGENT_SELECTION_SETTING_ID_V1)).toEqual(storedValue({
            ask: storedSelection({ agentTargetKey: CODEX_KEY }),
        }));
        expect(fixture.rejectedExpectedRevisions()).toHaveLength(1);
    });

    it('writes against the revision it read', async () => {
        const fixture = createTestkitAccountSettings();
        const revisionBeforeWrite = fixture.revision();

        await mutateTriageAgentSelection(deps(fixture), {
            kind: 'set',
            intent: 'ask',
            agentTargetKey: CLAUDE_KEY,
            model: null,
        });

        expect(fixture.setCallCount()).toBe(1);
        expect(fixture.revision()).not.toBe(revisionBeforeWrite);
    });

    it('lets a failure that is not a revision conflict surface as itself', async () => {
        const fixture = createTestkitAccountSettings();
        const failing = {
            snapshot: fixture.settings.snapshot.bind(fixture.settings),
            set: async () => {
                throw new Error('settings store unavailable');
            },
        };

        await expect(mutateTriageAgentSelection({ settings: failing }, {
            kind: 'set',
            intent: 'ask',
            agentTargetKey: CLAUDE_KEY,
            model: null,
        })).rejects.toThrow('settings store unavailable');
    });
});
