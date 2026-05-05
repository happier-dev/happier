import { describe, expect, it } from 'vitest';

import { decodeAutomationTemplate, encodeAutomationTemplate } from './automationTemplateCodec';

describe('automationTemplateCodec', () => {
    it('encodes and decodes a valid template', () => {
        const encoded = encodeAutomationTemplate({
            directory: '/tmp/project',
            agent: 'codex',
            prompt: 'Ship it',
            transcriptStorage: 'direct',
            permissionMode: 'default',
            permissionModeUpdatedAt: 123,
            windowsTerminalWindowName: 'happier-qa',
            mcpSelection: {
                v: 1,
                managedServersEnabled: false,
                forceIncludeServerIds: ['server-portable'],
                forceExcludeServerIds: [],
            },
        });

        const decoded = decodeAutomationTemplate(encoded);
        expect(decoded).toEqual(
            expect.objectContaining({
                directory: '/tmp/project',
                agent: 'codex',
                prompt: 'Ship it',
                transcriptStorage: 'direct',
                windowsTerminalWindowName: 'happier-qa',
                mcpSelection: {
                    v: 1,
                    managedServersEnabled: false,
                    forceIncludeServerIds: ['server-portable'],
                    forceExcludeServerIds: [],
                },
            }),
        );
    });

    it('returns null when payload is not valid JSON or schema-compatible', () => {
        expect(decodeAutomationTemplate('')).toBeNull();
        expect(decodeAutomationTemplate('{')).toBeNull();
        expect(decodeAutomationTemplate(JSON.stringify({ directory: '' }))).toBeNull();
    });

    it('maps legacy experimentalCodexAcp payloads onto canonical codexBackendMode on decode', () => {
        const decoded = decodeAutomationTemplate(JSON.stringify({
            directory: '/tmp/project',
            agent: 'codex',
            experimentalCodexAcp: true,
        }));

        expect(decoded).toEqual(expect.objectContaining({
            directory: '/tmp/project',
            agent: 'codex',
            codexBackendMode: 'acp',
        }));
        expect(decoded?.experimentalCodexAcp).toBeUndefined();
    });

    it('rejects workspace-linked template payloads', () => {
        const decoded = decodeAutomationTemplate(JSON.stringify({
            directory: '/tmp/project',
            agent: 'codex',
            workspaceId: 'ws_payments',
            workspaceLocationId: 'loc_local',
            workspaceCheckoutId: 'checkout_feature_auth',
        }));

        expect(decoded).toBeNull();
    });
});
