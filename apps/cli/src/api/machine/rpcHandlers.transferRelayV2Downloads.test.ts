import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { TransferRelayV2SendEnvelope } from '@happier-dev/protocol';
import { createTransferRecipientKeyPair, decryptEncryptedTransferChunkEnvelope } from '@/machines/transfer/transferChunkEncryption';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { registerMachineRpcHandlers } from './rpcHandlers';

type Handler = (data: unknown) => Promise<any>;

function createRpcHandlerManager(): { handlers: Map<string, Handler>; registerHandler: (method: string, handler: Handler) => void } {
    const handlers = new Map<string, Handler>();
    return {
        handlers,
        registerHandler(method, handler) {
            handlers.set(method, handler);
        },
    };
}

function git(cwd: string, args: readonly string[]): string {
    return execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        env: {
            ...process.env,
            GIT_AUTHOR_NAME: 'Happier Bot',
            GIT_AUTHOR_EMAIL: 'bot@example.com',
            GIT_COMMITTER_NAME: 'Happier Bot',
            GIT_COMMITTER_EMAIL: 'bot@example.com',
        },
    }).trim();
}

function createTransferRelayChannelHarness(machineId: string) {
    const listeners = new Set<(payload: TransferRelayV2SendEnvelope) => void>();
    const sent: TransferRelayV2SendEnvelope[] = [];

    return {
        sent,
        channel: {
            machineId,
            onEnvelope(listener: (payload: TransferRelayV2SendEnvelope) => void) {
                listeners.add(listener);
                return () => {
                    listeners.delete(listener);
                };
            },
            sendEnvelope(payload: TransferRelayV2SendEnvelope) {
                sent.push(payload);
            },
        },
        emitFromUser(payload: TransferRelayV2SendEnvelope) {
            for (const listener of listeners) {
                listener(payload);
            }
        },
    };
}

async function waitForSentCount(sent: readonly TransferRelayV2SendEnvelope[], count: number): Promise<void> {
    const startedAt = Date.now();
    while (sent.length < count) {
        if (Date.now() - startedAt > 2_000) {
            throw new Error(`Timed out waiting for ${count} relay envelopes; saw ${sent.length}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

describe('rpcHandlers relay-v2 download wiring', () => {
    it('streams prompt asset downloads over the live relay-v2 channel', async () => {
        const homeDir = mkdtempSync(join(tmpdir(), 'happier-prompt-relay-home-'));

        try {
            mkdirSync(join(homeDir, '.agents', 'skills', 'reviewer'), { recursive: true });
            writeFileSync(join(homeDir, '.agents', 'skills', 'reviewer', 'SKILL.md'), '# Reviewer\n', 'utf8');
            writeFileSync(join(homeDir, '.agents', 'skills', 'reviewer', 'notes.txt'), 'Remember this\n', 'utf8');

            const mgr = createRpcHandlerManager();
            const relay = createTransferRelayChannelHarness('machine-1');
            registerMachineRpcHandlers({
                rpcHandlerManager: mgr as any,
                handlers: {
                    spawnSession: async () => ({ type: 'error', errorCode: 'unknown', errorMessage: 'not implemented' }) as any,
                    stopSession: async () => true,
                    requestShutdown: () => {},
                    transferRelayV2Channel: relay.channel,
                },
                deps: {
                    promptAssetsHomedir: () => homeDir,
                },
            });

            const init = mgr.handlers.get(RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_INIT);
            if (!init) throw new Error('expected prompt asset download init handler');

            const recipientKeyPair = createTransferRecipientKeyPair();
            const initResponse = await init({
                assetTypeId: 'agents.skill',
                scope: 'user',
                externalRef: { skillName: 'reviewer' },
                recipientPublicKeyBase64: recipientKeyPair.recipientPublicKeyBase64,
            });
            expect(initResponse).toMatchObject({ success: true, downloadId: expect.any(String) });

            relay.emitFromUser({
                scopeUserId: 'user-1',
                sender: {
                    kind: 'user',
                    socketId: 'socket-1',
                },
                recipient: {
                    kind: 'machine',
                    machineId: 'machine-1',
                },
                envelope: {
                    transferId: initResponse.downloadId,
                    kind: 'open',
                    recipientPublicKeyBase64: recipientKeyPair.recipientPublicKeyBase64,
                },
            });

            await waitForSentCount(relay.sent, 1);
            expect(relay.sent[0]).toMatchObject({
                scopeUserId: 'user-1',
                sender: {
                    kind: 'machine',
                    machineId: 'machine-1',
                },
                recipient: {
                    kind: 'user',
                },
                envelope: {
                    transferId: initResponse.downloadId,
                    kind: 'chunk',
                    sequence: 0,
                },
            });

            const chunkEnvelope = relay.sent[0]?.envelope;
            if (!chunkEnvelope || chunkEnvelope.kind !== 'chunk' || !chunkEnvelope.encryptedDataKeyEnvelopeBase64) {
                throw new Error('expected encrypted chunk envelope');
            }
            const payload = JSON.parse(decryptEncryptedTransferChunkEnvelope({
                transferId: initResponse.downloadId,
                sequence: chunkEnvelope.sequence,
                payloadBase64: chunkEnvelope.payloadBase64,
                encryptedDataKeyEnvelopeBase64: chunkEnvelope.encryptedDataKeyEnvelopeBase64,
                recipientSecretKeySeed: recipientKeyPair.recipientSecretKeySeed,
            }).toString('utf8'));
            expect(payload).toMatchObject({
                assetTypeId: 'agents.skill',
                title: 'reviewer',
                bundleSchemaId: 'skills.skill_md_v1',
            });

            relay.emitFromUser({
                scopeUserId: 'user-1',
                sender: {
                    kind: 'user',
                    socketId: 'socket-1',
                },
                recipient: {
                    kind: 'machine',
                    machineId: 'machine-1',
                },
                envelope: {
                    transferId: initResponse.downloadId,
                    kind: 'ack',
                    nextSequence: 1,
                },
            });

            await waitForSentCount(relay.sent, 2);
            expect(relay.sent[1]).toMatchObject({
                scopeUserId: 'user-1',
                sender: {
                    kind: 'machine',
                    machineId: 'machine-1',
                },
                recipient: {
                    kind: 'user',
                },
                envelope: {
                    transferId: initResponse.downloadId,
                    kind: 'finish',
                    manifestHash: expect.stringMatching(/^sha256:/),
                },
            });
        } finally {
            rmSync(homeDir, { recursive: true, force: true });
        }
    });

    it('streams prompt registry downloads over the live relay-v2 channel', async () => {
        const repo = mkdtempSync(join(tmpdir(), 'happier-prompt-registry-relay-repo-'));
        const happierHomeDir = mkdtempSync(join(tmpdir(), 'happier-prompt-registry-relay-home-'));

        try {
            mkdirSync(join(repo, 'reviewer'), { recursive: true });
            writeFileSync(join(repo, 'reviewer', 'SKILL.md'), '# Reviewer\n', 'utf8');
            writeFileSync(join(repo, 'reviewer', 'notes.txt'), 'remember me\n', 'utf8');
            git(repo, ['init', '-b', 'main']);
            git(repo, ['add', '.']);
            git(repo, ['commit', '-m', 'init']);

            const mgr = createRpcHandlerManager();
            const relay = createTransferRelayChannelHarness('machine-1');
            registerMachineRpcHandlers({
                rpcHandlerManager: mgr as any,
                handlers: {
                    spawnSession: async () => ({ type: 'error', errorCode: 'unknown', errorMessage: 'not implemented' }) as any,
                    stopSession: async () => true,
                    requestShutdown: () => {},
                    transferRelayV2Channel: relay.channel,
                },
                deps: {
                    promptAssetsHappierHomeDir: () => happierHomeDir,
                },
            });

            const scanSource = mgr.handlers.get(RPC_METHODS.DAEMON_PROMPT_REGISTRY_SCAN_SOURCE);
            const downloadInit = mgr.handlers.get(RPC_METHODS.DAEMON_PROMPT_REGISTRY_DOWNLOAD_INIT);
            if (!scanSource || !downloadInit) {
                throw new Error('expected prompt registry handlers');
            }

            const configuredSources = [{
                id: 'local-skills',
                adapterId: 'git',
                title: 'Local skills',
                enabled: true,
                config: {
                    repositoryUrl: repo,
                },
            }];

            const scan = await scanSource({
                sourceId: 'git:local-skills',
                configuredSources,
            });
            expect(scan).toMatchObject({ ok: true });

            const recipientKeyPair = createTransferRecipientKeyPair();
            const initResponse = await downloadInit({
                sourceId: 'git:local-skills',
                itemId: scan.items[0]?.itemId,
                configuredSources,
                recipientPublicKeyBase64: recipientKeyPair.recipientPublicKeyBase64,
            });
            expect(initResponse).toMatchObject({ success: true, downloadId: expect.any(String) });

            relay.emitFromUser({
                scopeUserId: 'user-1',
                sender: {
                    kind: 'user',
                    socketId: 'socket-1',
                },
                recipient: {
                    kind: 'machine',
                    machineId: 'machine-1',
                },
                envelope: {
                    transferId: initResponse.downloadId,
                    kind: 'open',
                    recipientPublicKeyBase64: recipientKeyPair.recipientPublicKeyBase64,
                },
            });

            await waitForSentCount(relay.sent, 1);
            const chunkEnvelope = relay.sent[0]?.envelope;
            if (!chunkEnvelope || chunkEnvelope.kind !== 'chunk' || !chunkEnvelope.encryptedDataKeyEnvelopeBase64) {
                throw new Error('expected encrypted chunk envelope');
            }
            const payload = JSON.parse(decryptEncryptedTransferChunkEnvelope({
                transferId: initResponse.downloadId,
                sequence: chunkEnvelope.sequence,
                payloadBase64: chunkEnvelope.payloadBase64,
                encryptedDataKeyEnvelopeBase64: chunkEnvelope.encryptedDataKeyEnvelopeBase64,
                recipientSecretKeySeed: recipientKeyPair.recipientSecretKeySeed,
            }).toString('utf8'));
            expect(payload).toMatchObject({
                sourceId: 'git:local-skills',
                title: 'reviewer',
                bundleSchemaId: 'skills.skill_md_v1',
            });

            relay.emitFromUser({
                scopeUserId: 'user-1',
                sender: {
                    kind: 'user',
                    socketId: 'socket-1',
                },
                recipient: {
                    kind: 'machine',
                    machineId: 'machine-1',
                },
                envelope: {
                    transferId: initResponse.downloadId,
                    kind: 'ack',
                    nextSequence: 1,
                },
            });

            await waitForSentCount(relay.sent, 2);
            expect(relay.sent[1]).toMatchObject({
                envelope: {
                    transferId: initResponse.downloadId,
                    kind: 'finish',
                    manifestHash: expect.stringMatching(/^sha256:/),
                },
            });
        } finally {
            rmSync(repo, { recursive: true, force: true });
            rmSync(happierHomeDir, { recursive: true, force: true });
        }
    });
});
