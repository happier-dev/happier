import { describe, expect, it } from 'vitest';

import { resolveActionApprovalRouting } from '../actionApprovalPolicy.js';
import { getActionSpec } from '../actionSpecs.js';
import type { ActionsSettingsV1 } from '../actionSettings.js';

const EMPTY_SETTINGS = { v: 1, actions: {} } as unknown as ActionsSettingsV1;
const present = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } } as const;

describe('Machine terminal reads never ask (opening a Machine page lists its terminals)', () => {
    it.each(['machines.terminal.list', 'machines.terminal.read'] as const)('a person reading with %s gets no confirmation', actionId => {
        expect(resolveActionApprovalRouting({ actionId, spec: getActionSpec(actionId), context: present, settings: EMPTY_SETTINGS }).required).toBe(false);
    });

    it.each(['machines.terminal.close', 'machines.terminal.restart'] as const)('%s still confirms in the app', actionId => {
        expect(resolveActionApprovalRouting({ actionId, spec: getActionSpec(actionId), context: present, settings: EMPTY_SETTINGS }).required).toBe(true);
    });
});
