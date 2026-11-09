import type { CapturedMethod } from './staticCapture.js';
import { captureStaticRegistrationMethod, requireStaticRegistrationObject } from './staticCapture.js';

export function validateAgentExternalSessionTakeoverContribution(
    value: unknown,
) {
    const receiver = requireStaticRegistrationObject(
        value,
        'External Session takeover contribution',
    );
    return Object.freeze({
        resolveLaunch: captureStaticRegistrationMethod<CapturedMethod>(
            receiver,
            'resolveLaunch',
            'External Session takeover contribution.resolveLaunch',
            true,
        )!,
    });
}
