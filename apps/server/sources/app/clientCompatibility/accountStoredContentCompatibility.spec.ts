import { describe, expect, it, vi } from 'vitest';

import {
    buildAccountStoredContentUpgradeRequired,
    CURRENT_ACCOUNT_STORED_CONTENT_REQUIREMENTS,
    evaluateAccountStoredContentCompatibility,
} from './accountStoredContentCompatibility';

describe('account-stored-content compatibility', () => {
    it('treats missing and malformed declarations as legacy callers without rejecting their connection', () => {
        expect(evaluateAccountStoredContentCompatibility({ status: 'missing' })).toMatchObject({
            supportsCurrentProtocol: false,
            supportsPluginDataProtocol: false,
            supportsSessionAccessWitnessProtocol: false,
            outcome: 'legacy-missing',
        });
        expect(evaluateAccountStoredContentCompatibility({ status: 'malformed' })).toMatchObject({
            supportsCurrentProtocol: false,
            supportsPluginDataProtocol: false,
            supportsSessionAccessWitnessProtocol: false,
            outcome: 'legacy-malformed',
        });
    });

    it('keeps v1 legacy, preserves v2 current stored-content behavior, and reserves additive change-page fields by protocol version', () => {
        expect(evaluateAccountStoredContentCompatibility({
            status: 'valid',
            declaration: { v: 1, protocolVersion: 1 },
        })).toMatchObject({
            supportsCurrentProtocol: false,
            supportsPluginDataProtocol: false,
            supportsSessionAccessWitnessProtocol: false,
            outcome: 'legacy-protocol-too-old',
        });
        expect(evaluateAccountStoredContentCompatibility({
            status: 'valid',
            declaration: { v: 1, protocolVersion: 2 },
        })).toMatchObject({
            supportsCurrentProtocol: true,
            supportsPluginDataProtocol: false,
            supportsSessionAccessWitnessProtocol: false,
            outcome: 'accepted',
        });
        expect(evaluateAccountStoredContentCompatibility({
            status: 'valid',
            declaration: { v: 1, protocolVersion: 4 },
        })).toMatchObject({
            supportsCurrentProtocol: true,
            supportsPluginDataProtocol: true,
            supportsSessionAccessWitnessProtocol: true,
            outcome: 'accepted',
        });
        expect(evaluateAccountStoredContentCompatibility({
            status: 'valid',
            declaration: { v: 1, protocolVersion: 3 },
        })).toMatchObject({
            supportsCurrentProtocol: true,
            supportsPluginDataProtocol: true,
            supportsSessionAccessWitnessProtocol: false,
            outcome: 'accepted',
        });
    });

    it('uses a separate strict account-stored-content upgrade requirement', () => {
        expect(CURRENT_ACCOUNT_STORED_CONTENT_REQUIREMENTS).toMatchObject({
            minimumProtocolVersion: 2,
            currentProtocolVersion: 3,
        });
        expect(buildAccountStoredContentUpgradeRequired()).toEqual({
            error: 'client-upgrade-required',
            requirement: {
                v: 1,
                kind: 'account-stored-content',
                minimumProtocolVersion: 2,
            },
        });
    });

});
