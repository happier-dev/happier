import { describe, expect, it } from 'vitest';
import { SessionModelSelectionV1Schema } from '@happier-dev/protocol';

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

    it('roundtrips provider-bound model selection identity', () => {
        const modelSelection = SessionModelSelectionV1Schema.parse({
            v: 1,
            updatedAt: 123,
            ref: {
                agentTargetKey: 'backend:codex',
                providerConnectionId: 'pc_01J00000000000000000000000',
                modelId: 'openai/gpt-5.5',
            },
        });

        const decoded = decodeAutomationTemplate(encodeAutomationTemplate({
            directory: '/tmp/project',
            backendTarget: { kind: 'backend', backendId: 'codex' },
            modelSelection,
        }));

        expect(decoded?.modelSelection).toEqual(modelSelection);
    });

    it('writes only the canonical selection when legacy model fields are also present', () => {
        const encoded = encodeAutomationTemplate({
            directory: '/tmp/project',
            modelSelection: SessionModelSelectionV1Schema.parse({
                v: 1,
                updatedAt: 123,
                ref: {
                    agentTargetKey: 'backend:codex',
                    providerConnectionId: null,
                    modelId: 'gpt-5.5',
                },
            }),
            modelId: 'legacy-model',
            modelUpdatedAt: 10,
        });

        expect(JSON.parse(encoded)).not.toEqual(expect.objectContaining({
            modelId: expect.anything(),
            modelUpdatedAt: expect.anything(),
        }));
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

    it('preserves an authored existing-branch checkout draft through encode and decode', () => {
        const encoded = encodeAutomationTemplate({
            directory: '/tmp/project',
            agent: 'codex',
            checkoutCreationDraft: {
                kind: 'git_worktree',
                displayName: 'feature/auth',
                baseRef: 'main',
                branchMode: 'existing',
            },
        });

        expect(JSON.parse(encoded).checkoutCreationDraft).toEqual({
            kind: 'git_worktree',
            displayName: 'feature/auth',
            baseRef: 'main',
            branchMode: 'existing',
        });
        expect(decodeAutomationTemplate(encoded)?.checkoutCreationDraft).toEqual({
            kind: 'git_worktree',
            displayName: 'feature/auth',
            baseRef: 'main',
            branchMode: 'existing',
        });
    });

    it('leaves an omitted checkout branch mode omitted instead of writing a codec default', () => {
        const encoded = encodeAutomationTemplate({
            directory: '/tmp/project',
            agent: 'codex',
            checkoutCreationDraft: {
                kind: 'git_worktree',
                displayName: 'feature/auth',
                baseRef: null,
            },
        });

        expect(JSON.parse(encoded).checkoutCreationDraft).toEqual({
            kind: 'git_worktree',
            displayName: 'feature/auth',
            baseRef: null,
        });
        expect(decodeAutomationTemplate(encoded)?.checkoutCreationDraft?.branchMode).toBeUndefined();
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
