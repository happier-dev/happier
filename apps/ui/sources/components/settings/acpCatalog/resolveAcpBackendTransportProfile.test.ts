import { describe, expect, it } from 'vitest';

import { resolveAcpBackendTransportProfile } from './resolveAcpBackendTransportProfile';

describe('resolveAcpBackendTransportProfile', () => {
    it('uses the Kiro transport profile for kiro-cli backends', () => {
        expect(resolveAcpBackendTransportProfile({
            command: 'kiro-cli',
            auth: { support: 'status_only' },
        })).toBe('kiro');
    });

    it('uses the Kiro transport profile for Kiro auth parser metadata', () => {
        expect(resolveAcpBackendTransportProfile({
            command: 'custom-wrapper',
            auth: {
                support: 'status_only',
                parser: 'kiroWhoamiJson',
            },
        })).toBe('kiro');
    });

    it('defaults all other custom ACP backends to the generic transport profile', () => {
        expect(resolveAcpBackendTransportProfile({
            command: 'custom-acp',
            auth: { support: 'unsupported' },
        })).toBe('generic');
    });
});
