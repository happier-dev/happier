import { describe, expect, it } from 'vitest';

import { resolveNativeAgentLaunchEnvironment } from './launchEnvironment';

describe('resolveNativeAgentLaunchEnvironment', () => {
    it.each(['linux', 'darwin', 'win32'] as const)('inherits only documented tool idle values and preserves authored overrides, unsets and Off on %s', platform => {
        const key = platform === 'win32' ? 'Agent_Browser_Idle_Timeout_Ms' : 'AGENT_BROWSER_IDLE_TIMEOUT_MS';
        const processEnv = { [key]: '300000', PRIVATE_AMBIENT: 'must-not-leak' };
        expect(resolveNativeAgentLaunchEnvironment({ processEnv, platform }).values)
            .toEqual({ [key]: '300000' });
        expect(resolveNativeAgentLaunchEnvironment({ processEnv, platform,
            environmentVariables: { AGENT_BROWSER_IDLE_TIMEOUT_MS: '' } }).values)
            .toEqual({ AGENT_BROWSER_IDLE_TIMEOUT_MS: '' });
        expect(resolveNativeAgentLaunchEnvironment({ processEnv, platform,
            unsetEnvironmentVariables: ['AGENT_BROWSER_IDLE_TIMEOUT_MS'] }).values).toEqual({});
        // Off is already captured at Session birth; no new policy read/default is invented here.
        expect(resolveNativeAgentLaunchEnvironment({ processEnv: {}, platform }).values).toEqual({});
    });
    it('inherits command lookup and host TLS trust while keeping ambient credentials and host controls private', () => {
        expect(resolveNativeAgentLaunchEnvironment({
            processEnv: { PATH: '/usr/local/bin:/usr/bin:/bin', PATHEXT: '.EXE',
                NODE_EXTRA_CA_CERTS: '/host/trusted-ca.pem',
                ANTHROPIC_API_KEY: 'ambient-secret', HAPPIER_TOKEN: 'ambient-account-token',
                HAPPIER_SESSION_ATTACH_FILE: '/private/runner-attach' },
            environmentVariables: { PROFILE_SECRET: 'admitted-secret' },
            platform: 'linux',
        })).toEqual({ values: { PATH: '/usr/local/bin:/usr/bin:/bin', NODE_EXTRA_CA_CERTS: '/host/trusted-ca.pem',
            PROFILE_SECRET: 'admitted-secret' }, unset: [] });
    });

    it.each(['linux', 'darwin', 'win32'] as const)('preserves explicit empty PATH and explicit unsets on %s', platform => {
        const processEnv = { PATH: '/inherited', PATHEXT: '.EXE', NODE_EXTRA_CA_CERTS: '/host/trusted-ca.pem' };
        expect(resolveNativeAgentLaunchEnvironment({ processEnv, environmentVariables: { PATH: '' }, platform }).values.PATH).toBe('');
        expect(resolveNativeAgentLaunchEnvironment({ processEnv,
            environmentVariables: { NODE_EXTRA_CA_CERTS: '/profile/trusted-ca.pem' }, platform }).values.NODE_EXTRA_CA_CERTS).toBe('/profile/trusted-ca.pem');
        const unset = resolveNativeAgentLaunchEnvironment({ processEnv, unsetEnvironmentVariables: ['PATH', 'NODE_EXTRA_CA_CERTS'], platform });
        expect(unset.values).not.toHaveProperty('PATH');
        expect(unset.values).not.toHaveProperty('NODE_EXTRA_CA_CERTS');
        expect(unset.unset).toEqual(['PATH', 'NODE_EXTRA_CA_CERTS']);
        expect(processEnv.PATH).toBe('/inherited');
    });

    it('uses Windows environment identity for inherited Path and PATHEXT plus explicit overrides', () => {
        expect(resolveNativeAgentLaunchEnvironment({
            processEnv: { Path: 'C:\\Windows\\System32;C:\\Tools', PathExt: '.CMD;.EXE',
                Node_Extra_Ca_Certs: 'C:\\trust\\host.pem',
                OPENAI_API_KEY: 'ambient-secret' },
            environmentVariables: { PATH: 'D:\\SelectedTools', NODE_EXTRA_CA_CERTS: 'D:\\trust\\profile.pem' },
            platform: 'win32',
        })).toEqual({ values: { PATH: 'D:\\SelectedTools', PathExt: '.CMD;.EXE', NODE_EXTRA_CA_CERTS: 'D:\\trust\\profile.pem' }, unset: [] });
    });

    it.each(['linux', 'darwin', 'win32'] as const)('inherits Windows machine paths without ambient login homes or credentials on %s', platform => {
        const windowsEnvironment = {
            SystemRoot: 'D:\\Windows', ComSpec: 'D:\\Windows\\System32\\cmd.exe', PATHEXT: '.EXE;.CMD', WINDIR: 'D:\\Windows',
            ProgramFiles: 'D:\\Applications', 'ProgramFiles(x86)': 'D:\\Applications (x86)', ProgramW6432: 'D:\\Applications',
            CommonProgramFiles: 'D:\\Applications\\Common Files', 'CommonProgramFiles(x86)': 'D:\\Applications (x86)\\Common Files',
            CommonProgramW6432: 'D:\\Applications\\Common Files', pRoGrAmDaTa: 'D:\\ProgramData',
            ALLUSERSPROFILE: 'D:\\ProgramData', PUBLIC: 'D:\\Users\\Public', COMPUTERNAME: 'WINDOWS-HOST',
            OS: 'Windows_NT', pRoCeSsOr_ArChItEcTuRe: 'AMD64',
        };
        const processEnv = { ...windowsEnvironment, HOME: 'D:\\Users\\private', USERPROFILE: 'D:\\Users\\private',
            APPDATA: 'D:\\Users\\private\\AppData\\Roaming', OPENAI_API_KEY: 'ambient-secret' };
        const result = resolveNativeAgentLaunchEnvironment({ processEnv, platform });
        expect(result.values).toEqual(platform === 'win32' ? windowsEnvironment : {});
        expect(processEnv.ProgramFiles).toBe('D:\\Applications');
        if (platform === 'win32') {
            const overridden = resolveNativeAgentLaunchEnvironment({ processEnv, platform,
                environmentVariables: { PROGRAMFILES: 'E:\\Selected' }, unsetEnvironmentVariables: ['programfiles(x86)'] });
            expect(overridden.values.PROGRAMFILES).toBe('E:\\Selected');
            expect(overridden.values).not.toHaveProperty('ProgramFiles');
            expect(overridden.values).not.toHaveProperty('ProgramFiles(x86)');
            expect(overridden.unset).toEqual(['programfiles(x86)']);
        }
    });
});
