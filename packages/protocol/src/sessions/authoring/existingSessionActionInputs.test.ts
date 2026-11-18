import { describe, expect, it } from 'vitest';

import { SessionModeSetInputSchema } from '../../actions/specs/session/interaction.js';
import { StrictJsonValueSchema } from '../../json/strictJsonValue.js';
import { SessionAgentTransitionRequestV1Schema } from '../agentTransition.js';
import { buildExistingSessionAgentTransitionActionInput, buildExistingSessionModeActionInput } from './existingSessionActionInputs.js';

describe('existing Session Action inputs', () => {
    it('clears a synthetic default while preserving advertised modes', () => {
        const build = (modeId: string, availableModeIds: readonly string[]) => SessionModeSetInputSchema.parse(
            buildExistingSessionModeActionInput({ sessionId: 'session', modeId, availableModeIds }),
        );
        expect(build(' default ', ['code'])).toEqual({ sessionId: 'session', modeId: '' });
        expect(build(' default ', ['default', 'code'])).toEqual({ sessionId: 'session', modeId: 'default' });
        expect(build(' code ', ['code'])).toEqual({ sessionId: 'session', modeId: 'code' });
    });

    it('builds JSON-safe settings-only transitions and preserves supplied message input', () => {
        const request = { sessionId: 'session', expectedCurrentAgentId: 'claude', selection: { v: 1 as const, agentId: 'codex' } };
        const settings = buildExistingSessionAgentTransitionActionInput({ ...request, input: undefined });
        expect(StrictJsonValueSchema.parse(settings)).toEqual(request);
        expect(SessionAgentTransitionRequestV1Schema.parse({ v: 1, ...settings })).toEqual({ v: 1, ...request });
        const input = { text: 'Continue', localId: 'local-1', meta: { displayText: 'Keep this display' } };
        expect(buildExistingSessionAgentTransitionActionInput({ ...request, input })).toEqual({ ...request, input });
    });
});
