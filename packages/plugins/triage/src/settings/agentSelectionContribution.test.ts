import { describe, expect, it } from 'vitest';

import { TRIAGE_NO_AGENT_SELECTIONS_V1, parseTriageAgentSelections } from './agentSelection.js';
import { TRIAGE_AGENT_SELECTION_SETTINGS_CONTRIBUTION_V1 } from './agentSelectionContribution.js';

const [field] = TRIAGE_AGENT_SELECTION_SETTINGS_CONTRIBUTION_V1.fields;

describe('TRIAGE_AGENT_SELECTION_SETTINGS_CONTRIBUTION_V1', () => {
    it('declares a default the owner reads as "no agent chosen"', () => {
        // The host writes this declared default into a fresh Account record, and
        // the owner has to read it back as an ordinary unset value. A default the
        // parser called `unreadable` would make the setting permanently
        // unwritable on every new account, because the writer declines to
        // overwrite a value it cannot read.
        expect(parseTriageAgentSelections(field.default)).toEqual({
            kind: 'parsed',
            value: TRIAGE_NO_AGENT_SELECTIONS_V1,
        });
    });

    it('declares exactly the members the owner admits', () => {
        // Built from the declaration's own property names, so a member added to
        // or dropped from either side is read back as `unreadable` here.
        const declared = Object.fromEntries(Object.keys(field.schema.properties).map((key) => (
            key === 'v' ? [key, 1] : [key, null]
        )));

        expect(parseTriageAgentSelections(declared).kind).toBe('parsed');
    });

    it('declares exactly the selection members the owner admits', () => {
        const [selectionSchema] = field.schema.properties.ask.anyOf;
        const declaredSelection = Object.fromEntries(
            Object.keys(selectionSchema.properties).map((key) => (
                key === 'agentTargetKey' ? [key, 'agent:happier.claude/claude'] : [key, null]
            )),
        );

        const read = parseTriageAgentSelections({ v: 1, ask: declaredSelection, fix: null });

        expect(read.kind).toBe('parsed');
        expect(read.value.ask?.agentTargetKey).toBe('agent:happier.claude/claude');
    });

    it('keeps the value out of the generic settings page', () => {
        // A visible field could only offer a static option list, which cannot
        // enumerate the host's live agents.
        expect(field.presentation).toEqual({ hidden: true });
    });
});
