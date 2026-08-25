import { mkdtemp, mkdir, realpath, rename, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
    AgentExternalSessionsResolvedIdentity,
} from '@happier-dev/plugin-sdk/sessions/external';
import { describe, expect, it, vi } from 'vitest';

import { createClaudeExternalSessionObservationContribution } from './observation.js';

function linkedSource(params: Readonly<{
    configDir: string;
    projectId?: string;
    remoteSessionId?: string;
}>): AgentExternalSessionsResolvedIdentity {
    const projectId = params.projectId ?? 'project-a';
    return {
        source: {
            kind: 'claudeConfig',
            configDir: params.configDir,
            projectId,
        },
        remoteSessionId: params.remoteSessionId ?? 'session-a',
        linkData: { projectId },
    };
}

async function createTranscriptFixture(): Promise<Readonly<{
    configDir: string;
    filePath: string;
    identity: AgentExternalSessionsResolvedIdentity;
}>> {
    const root = await mkdtemp(join(tmpdir(), 'claude-observation-'));
    const configDir = join(root, '.claude');
    const transcriptDir = join(configDir, 'projects', 'project-a');
    const filePath = join(transcriptDir, 'session-a.jsonl');
    await mkdir(transcriptDir, { recursive: true });
    await writeFile(filePath, '{"type":"user"}\n', 'utf8');
    return {
        configDir,
        filePath,
        identity: linkedSource({ configDir }),
    };
}

describe('Claude External Session observation', () => {
    it('groups one JSONL link with bounded opaque keys and obtains file authority only from reconciliation', async () => {
        const fixture = await createTranscriptFixture();
        const contribution = createClaudeExternalSessionObservationContribution({
            env: { CLAUDE_CONFIG_DIR: fixture.configDir },
        });
        const initial = contribution.describeResource(fixture.identity);
        const duplicate = contribution.describeResource(fixture.identity);
        const canonicalFilePath = await realpath(fixture.filePath);

        expect(duplicate).toEqual(initial);
        expect(Object.keys(initial).sort()).toEqual(['linkKey', 'resourceKey']);
        const authoritative = await contribution.reconcileResource({
            purpose: 'resource_descriptors',
            resourceKey: initial.resourceKey,
            links: [{
                linkKey: initial.linkKey,
                linkedSource: fixture.identity,
            }],
            signal: new AbortController().signal,
        });
        expect(authoritative).toEqual({
            purpose: 'resource_descriptors',
            outcomes: [{
                kind: 'described',
                descriptor: {
                    ...initial,
                    changeObservation: 'watch_file_changes',
                    watchFileChanges: { files: [canonicalFilePath] },
                },
            }],
        });
        expect(initial.resourceKey.length).toBeLessThanOrEqual(256);
        expect(initial.linkKey.length).toBeLessThanOrEqual(256);
        expect(initial.resourceKey).not.toContain(fixture.configDir);
        expect(initial.resourceKey).not.toContain('project-a');
        expect(initial.resourceKey).not.toContain('session-a');
        expect(initial.linkKey).not.toContain(fixture.configDir);
        expect(initial.linkKey).not.toContain('project-a');
        expect(initial.linkKey).not.toContain('session-a');

        const replacement = `${fixture.filePath}.replacement`;
        await writeFile(replacement, '{"type":"assistant"}\n', 'utf8');
        await unlink(fixture.filePath);
        await rename(replacement, fixture.filePath);

        const replaced = contribution.describeResource(fixture.identity);
        expect(replaced).toEqual(initial);
    });

    it('keeps observation passive when the activation surface cannot consume host file-follow', async () => {
        const fixture = await createTranscriptFixture();
        const contribution = createClaudeExternalSessionObservationContribution({
            env: { CLAUDE_CONFIG_DIR: fixture.configDir },
        });
        const descriptor = contribution.describeResource(fixture.identity);
        const emit = vi.fn();
        const requestReconcile = vi.fn();
        const disposable = await contribution.observeResource({
            resourceKey: descriptor.resourceKey,
            signal: new AbortController().signal,
            emit,
            requestReconcile,
            requestTranscriptRefresh() {},
        });

        expect(emit).not.toHaveBeenCalled();
        expect(requestReconcile).not.toHaveBeenCalled();
        await expect(Promise.resolve(disposable.dispose())).resolves.toBeUndefined();
        await expect(Promise.resolve(disposable.dispose())).resolves.toBeUndefined();
    });

    it.each(['a transcript symlink', 'a project-directory symlink', 'a projects-root symlink'])(
        'does not describe or reconcile %s outside the authorized projects root',
        async (replacement) => {
            const fixture = await createTranscriptFixture();
            const contribution = createClaudeExternalSessionObservationContribution({
                env: { CLAUDE_CONFIG_DIR: fixture.configDir },
                now: () => 200_000,
            });
            const grouping = contribution.describeResource(fixture.identity);
            const projectDir = join(fixture.configDir, 'projects', 'project-a');
            const outsideDir = join(fixture.configDir, '..', `outside-${replacement.replaceAll(' ', '-')}`);
            const outsideTranscript = join(outsideDir, 'session-a.jsonl');

            if (replacement === 'a transcript symlink') {
                await mkdir(outsideDir, { recursive: true });
                await writeFile(outsideTranscript, '{"type":"assistant"}\n', 'utf8');
                await unlink(fixture.filePath);
                await symlink(outsideTranscript, fixture.filePath);
            } else if (replacement === 'a project-directory symlink') {
                await rename(projectDir, outsideDir);
                await symlink(outsideDir, projectDir);
            } else {
                const projectsDir = join(fixture.configDir, 'projects');
                await rename(projectsDir, outsideDir);
                await symlink(outsideDir, projectsDir);
            }

            await expect(contribution.reconcileResource({
                purpose: 'resource_descriptors',
                resourceKey: grouping.resourceKey,
                links: [{ linkKey: grouping.linkKey, linkedSource: fixture.identity }],
                signal: new AbortController().signal,
            })).resolves.toEqual({
                purpose: 'resource_descriptors',
                outcomes: [{ kind: 'unavailable', linkKey: grouping.linkKey }],
            });
            await expect(contribution.reconcileResource({
                purpose: 'observation_evidence',
                resourceKey: grouping.resourceKey,
                links: [{ linkKey: grouping.linkKey, linkedSource: fixture.identity }],
                signal: new AbortController().signal,
            })).resolves.toEqual({
                purpose: 'observation_evidence',
                outcomes: [{
                    linkKey: grouping.linkKey,
                    facts: [{
                        kind: 'retrieval_failed',
                        evidenceClass: 'reconciliation',
                        observedAtMs: 200_000,
                        axis: 'turn_phase',
                    }],
                }],
            });
        },
    );

    it('preserves a deliberately symlinked Claude config root while watching the physical transcript', async () => {
        const fixture = await createTranscriptFixture();
        const configAlias = join(fixture.configDir, '..', 'claude-config-alias');
        await symlink(fixture.configDir, configAlias);
        const identity = linkedSource({ configDir: configAlias });
        const contribution = createClaudeExternalSessionObservationContribution({
            env: { CLAUDE_CONFIG_DIR: configAlias },
        });
        const grouping = contribution.describeResource(identity);

        await expect(contribution.reconcileResource({
            purpose: 'resource_descriptors',
            resourceKey: grouping.resourceKey,
            links: [{ linkKey: grouping.linkKey, linkedSource: identity }],
            signal: new AbortController().signal,
        })).resolves.toEqual({
            purpose: 'resource_descriptors',
            outcomes: [{
                kind: 'described',
                descriptor: {
                    ...grouping,
                    changeObservation: 'watch_file_changes',
                    watchFileChanges: { files: [await realpath(fixture.filePath)] },
                },
            }],
        });
    });

    it('reconciles advisory mtime without claiming liveness, completion, or idle', async () => {
        const fixture = await createTranscriptFixture();
        await utimes(fixture.filePath, new Date(95_000), new Date(95_000));
        const contribution = createClaudeExternalSessionObservationContribution({
            env: { CLAUDE_CONFIG_DIR: fixture.configDir },
            now: () => 100_000,
        });
        const descriptor = contribution.describeResource(fixture.identity);

        await expect(contribution.reconcileResource({
            purpose: 'observation_evidence',
            resourceKey: descriptor.resourceKey,
            links: [{
                linkKey: descriptor.linkKey,
                linkedSource: fixture.identity,
            }],
            signal: new AbortController().signal,
        })).resolves.toEqual({
            purpose: 'observation_evidence',
            outcomes: [{
                linkKey: descriptor.linkKey,
                facts: [{
                    kind: 'recent_activity',
                    evidenceClass: 'reconciliation',
                    observedAtMs: 100_000,
                    expiresAtMs: 115_000,
                }],
            }],
        });

        await utimes(fixture.filePath, new Date(10_000), new Date(10_000));
        const oldDescriptor = contribution.describeResource(fixture.identity);
        const oldResult = await contribution.reconcileResource({
            purpose: 'observation_evidence',
            resourceKey: oldDescriptor.resourceKey,
            links: [{
                linkKey: oldDescriptor.linkKey,
                linkedSource: fixture.identity,
            }],
            signal: new AbortController().signal,
        });
        expect(oldResult).toEqual({
            purpose: 'observation_evidence',
            outcomes: [{
                linkKey: oldDescriptor.linkKey,
                facts: [{
                    kind: 'successful_empty',
                    evidenceClass: 'reconciliation',
                    observedAtMs: 100_000,
                    expiresAtMs: 115_000,
                    emptyTurnPhase: 'unsupported',
                }],
            }],
        });
        expect(JSON.stringify(oldResult)).not.toMatch(/liveness|completed_boundary|idle/u);
    });

    it('reports missing or replaced resources as retrieval failure instead of quiescence', async () => {
        const fixture = await createTranscriptFixture();
        const contribution = createClaudeExternalSessionObservationContribution({
            env: { CLAUDE_CONFIG_DIR: fixture.configDir },
            now: () => 200_000,
        });
        const descriptor = contribution.describeResource(fixture.identity);
        await unlink(fixture.filePath);

        const result = await contribution.reconcileResource({
            purpose: 'observation_evidence',
            resourceKey: descriptor.resourceKey,
            links: [{
                linkKey: descriptor.linkKey,
                linkedSource: fixture.identity,
            }],
            signal: new AbortController().signal,
        });
        expect(result).toEqual({
            purpose: 'observation_evidence',
            outcomes: [{
                linkKey: descriptor.linkKey,
                facts: [{
                    kind: 'retrieval_failed',
                    evidenceClass: 'reconciliation',
                    observedAtMs: 200_000,
                    axis: 'turn_phase',
                }],
            }],
        });
        expect(JSON.stringify(result)).not.toMatch(/stopped|idle|completed_boundary/u);
    });

    it('returns the existing descriptor with the matching descriptor purpose', async () => {
        const fixture = await createTranscriptFixture();
        const contribution = createClaudeExternalSessionObservationContribution({
            env: { CLAUDE_CONFIG_DIR: fixture.configDir },
        });
        const descriptor = contribution.describeResource(fixture.identity);

        await expect(contribution.reconcileResource({
            purpose: 'resource_descriptors',
            resourceKey: descriptor.resourceKey,
            links: [{
                linkKey: descriptor.linkKey,
                linkedSource: fixture.identity,
            }],
            signal: new AbortController().signal,
        })).resolves.toEqual({
            purpose: 'resource_descriptors',
            outcomes: [{
                kind: 'described',
                descriptor: {
                    ...descriptor,
                    changeObservation: 'watch_file_changes',
                    watchFileChanges: {
                        files: [await realpath(fixture.filePath)],
                    },
                },
            }],
        });
    });
});
