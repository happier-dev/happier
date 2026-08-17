import { describe, expect, it } from 'vitest';

import {
    PredecessorVoiceCredentialBindingV1Schema,
    parsePredecessorVoiceCredentialBindings,
} from './voiceCredentialBindingCompatibility';

describe('predecessor Voice credential binding ingress', () => {
    it('preserves a valid account binding, every machine override, and approval metadata', () => {
        const binding = {
            providerId: 'realtime_elevenlabs',
            credentialBindings: {
                account: { api_key: 'secret-account' },
                byMachineId: {
                    machine_a: { api_key: 'secret-machine-a' },
                    machine_b: { api_key: 'secret-machine-b' },
                },
            },
            approvedRecipientContractDigest: `sha256:${'a'.repeat(64)}`,
        };

        expect(parsePredecessorVoiceCredentialBindings({
            credentialBindings: [binding],
        })).toEqual([binding]);
        expect(PredecessorVoiceCredentialBindingV1Schema.safeParse({
            contribution: {
                pluginId: 'happier.voice.elevenlabs',
                localId: 'realtime-elevenlabs',
            },
            credentialSlotId: 'api_key',
            credentialSource: { kind: 'savedSecret' },
            credentialBindings: binding.credentialBindings,
        }).success).toBe(false);
    });
});
