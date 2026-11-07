import { describe, expect, it } from 'vitest';
import { MAX_TRIAGE_ACTIONS_SERIALIZED_UTF8_BYTES_V1, TRIAGE_DEFAULT_ACTIONS_V1, parseTriageActions } from '../../settings/actions.js';
import { TriageReadActionsResultV1Schema } from '../../actions/actionsCatalogProtocol.js';

import {
    TRIAGE_UNREAD_ACTIONS_V1,
    readTriageActionsProjectionV1,
} from './actionsCommand.js';

describe('the mounted action catalog projection', () => {
    it('keeps appended built-ins readable when a valid stored catalog fills the Account KV byte boundary', () => {
        const custom = { ...TRIAGE_DEFAULT_ACTIONS_V1[0]!, actionId: 'custom', label: '' };
        const catalog = { v: 1, actions: [custom] };
        custom.label = 'a'.repeat(MAX_TRIAGE_ACTIONS_SERIALIZED_UTF8_BYTES_V1
            - new TextEncoder().encode(JSON.stringify(catalog)).byteLength);
        const read = parseTriageActions(catalog);
        expect(read.kind).toBe('parsed');
        const projection = TriageReadActionsResultV1Schema.parse({ v: 1, availability: 'parsed', revision: '0', actions: read.value.actions });
        expect(readTriageActionsProjectionV1(projection))
            .toEqual(read);
    });
    it('reads an empty catalog projection and disabled built-ins through the canonical catalog owner', () => {
        expect(readTriageActionsProjectionV1({ availability: 'parsed', actions: [] }).value.actions)
            .toEqual(TRIAGE_DEFAULT_ACTIONS_V1);
        const disabled = { ...TRIAGE_DEFAULT_ACTIONS_V1[3]!, enabled: false };
        const projection = TriageReadActionsResultV1Schema.parse({ v: 1, availability: 'parsed', revision: '0', actions: [disabled] });
        expect(readTriageActionsProjectionV1(projection).value.actions)
            .toEqual([disabled, ...TRIAGE_DEFAULT_ACTIONS_V1.filter(action => action.actionId !== disabled.actionId)]);
        expect(readTriageActionsProjectionV1({ availability: 'unavailable', actions: [] }))
            .toEqual(TRIAGE_UNREAD_ACTIONS_V1);
    });
    it('offers no executable seed before Account KV has authoritatively answered absent', () => {
        expect(TRIAGE_UNREAD_ACTIONS_V1).toEqual({
            kind: 'unreadable',
            value: { v: 1, actions: [] },
        });

        expect(readTriageActionsProjectionV1({
            availability: 'absent',
            actions: [{
                actionId: 'ask',
                label: 'Ask',
                enabled: true,
                appliesTo: ['issue'],
                profileId: null,
                workspaceMode: 'reference_only',
                target: { kind: 'agent', promptInvocationId: null, delivery: 'compose' },
            }],
        }).value.actions.map(action => action.actionId)).toEqual(TRIAGE_DEFAULT_ACTIONS_V1.map(action => action.actionId));
    });
});
