import { expect, it } from 'vitest';

import { resolveActionApprovalRouting } from './actionApprovalPolicy.js';
import { normalizeActionsSettingsV1 } from './actionSettings.js';
import { getActionSpec } from './actionSpecs.js';
import { USAGE_COACH_ACTION_IDS } from '../usage/usageActionIdsV1.js';

it.each(USAGE_COACH_ACTION_IDS)('uses default approval for delegated %s and lets the person act directly in the app', actionId => {
    const args = { actionId, spec: getActionSpec(actionId), settings: normalizeActionsSettingsV1({ v: 1 }) };
    const ownUi = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } } as const;

    const direct = resolveActionApprovalRouting({ ...args, context: ownUi });
    expect(direct.required).toBe(false);
    expect(direct.uiConfirmationRequired).not.toBe(true);

    for (const surface of ['agent', 'mcp', 'cli'] as const) {
        const context = { surface, authority: 'account_automation', actionCaller: {
            kind: 'session', sessionId: 'coach-session', starterDepth: 0, turnDepth: 0,
        } } as const;
        expect(resolveActionApprovalRouting({ ...args, context }).required, surface).toBe(true);
    }

    const settings = normalizeActionsSettingsV1({ v: 1, actions: {
        [actionId]: { approvalRequiredSurfaces: ['ui'] },
    } });
    expect(resolveActionApprovalRouting({ ...args, context: ownUi, settings }).uiConfirmationRequired).toBe(true);
});
