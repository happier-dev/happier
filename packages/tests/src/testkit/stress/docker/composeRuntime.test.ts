import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

const spawnMock = vi.fn();

vi.mock('node:child_process', () => ({
    spawn: spawnMock,
}));

type MockChildProcess = EventEmitter & Readonly<{
    stdout: EventEmitter;
    stderr: EventEmitter;
}>;

function createChildProcess(): MockChildProcess {
    const child = new EventEmitter() as MockChildProcess;
    Object.defineProperty(child, 'stdout', {
        value: new EventEmitter(),
        enumerable: true,
    });
    Object.defineProperty(child, 'stderr', {
        value: new EventEmitter(),
        enumerable: true,
    });
    return child;
}

describe('createComposeRuntime', () => {
    it('restarts one exact compose container without starting its sibling replicas', async () => {
        spawnMock.mockReset();
        spawnMock.mockImplementation(() => {
            const child = createChildProcess();
            queueMicrotask(() => child.emit('close', 0, null));
            return child;
        });

        const { createComposeRuntime } = await import('./composeRuntime');
        const runtime = createComposeRuntime({
            composeFilePath: '/tmp/topology/docker-compose.yml',
            composeProjectName: 'happier-stress-run',
            cwd: '/repo/root',
        });

        await expect(runtime.startContainer?.('api-container-b')).resolves.toBeUndefined();
        expect(spawnMock).toHaveBeenCalledWith(
            'docker',
            ['start', 'api-container-b'],
            expect.objectContaining({
                cwd: '/repo/root',
                stdio: ['ignore', 'pipe', 'pipe'],
            }),
        );
    });

    it('prebuilds the canonical server image with the stress server target, freshness labels, and drained output', async () => {
        spawnMock.mockReset();
        spawnMock.mockImplementation(() => {
            const child = createChildProcess();
            queueMicrotask(() => {
                child.stdout.emit('data', '#0 building\n');
                child.stderr.emit('data', 'warning output\n');
                child.emit('close', 0, null);
            });
            return child;
        });

        const { createComposeRuntime } = await import('./composeRuntime');
        const runtime = createComposeRuntime({
            composeFilePath: '/tmp/topology/docker-compose.yml',
            composeProjectName: 'happier-stress-run',
            cwd: '/repo/root',
        });

        await expect(
            runtime.buildServerImage('happier-stress-compose-topology-canonical-server', {
                labels: {
                    'happier.stress.owner': 'stress-harness',
                    'happier.stress.image-fingerprint': 'freshness-hash',
                    'happier.stress.repo-root': 'repo-fingerprint',
                },
                dockerfilePath: '/tmp/topology/Dockerfile.server-stress.generated',
                contextDir: '/repo/root',
            }),
        ).resolves.toBeUndefined();

        expect(spawnMock).toHaveBeenCalledTimes(1);
        expect(spawnMock).toHaveBeenCalledWith(
            'docker',
            [
                'build',
                '-f',
                '/tmp/topology/Dockerfile.server-stress.generated',
                '--target',
                'server-stress',
                '--label',
                'happier.stress.owner=stress-harness',
                '--label',
                'happier.stress.image-fingerprint=freshness-hash',
                '--label',
                'happier.stress.repo-root=repo-fingerprint',
                '-t',
                'happier-stress-compose-topology-canonical-server',
                '/repo/root',
            ],
            expect.objectContaining({
                cwd: '/repo/root',
                stdio: ['ignore', 'pipe', 'pipe'],
            }),
        );
    });

    it('starts the topology through docker compose up with build disabled after the image is prebuilt', async () => {
        spawnMock.mockReset();
        spawnMock.mockImplementation(() => {
            const child = createChildProcess();
            queueMicrotask(() => {
                child.stdout.emit('data', 'compose output\n');
                child.emit('close', 0, null);
            });
            return child;
        });

        const { createComposeRuntime } = await import('./composeRuntime');
        const runtime = createComposeRuntime({
            composeFilePath: '/tmp/topology/docker-compose.yml',
            composeProjectName: 'happier-stress-run',
            cwd: '/repo/root',
        });

        await expect(
            runtime.up({
                apiReplicas: 3,
                workerReplicas: 2,
            }),
        ).resolves.toBeUndefined();

        expect(spawnMock).toHaveBeenCalledTimes(1);
        expect(spawnMock).toHaveBeenCalledWith(
            'docker',
            [
                'compose',
                '-f',
                '/tmp/topology/docker-compose.yml',
                '-p',
                'happier-stress-run',
                'up',
                '-d',
                '--no-build',
                '--remove-orphans',
                '--scale',
                'api=3',
                '--scale',
                'worker=2',
            ],
            expect.objectContaining({
                cwd: '/repo/root',
                stdio: ['ignore', 'pipe', 'pipe'],
            }),
        );
    });

    it('rejects running service containers whose inherited image identity does not match the source tag and labels', async () => {
        spawnMock.mockReset();
        spawnMock
            .mockImplementationOnce(() => {
                const child = createChildProcess();
                queueMicrotask(() => {
                    child.stdout.emit('data', 'api-container\n');
                    child.emit('close', 0, null);
                });
                return child;
            })
            .mockImplementationOnce(() => {
                const child = createChildProcess();
                queueMicrotask(() => {
                    child.stdout.emit('data', JSON.stringify([{
                        Id: 'api-container',
                        Config: {
                            Image: 'happier-stress-compose-server-repo-a-source-b',
                            Labels: {
                                'happier.stress.owner': 'stress-harness',
                                'happier.stress.repo-root': 'repo-a',
                                'happier.stress.image-fingerprint': 'source-b',
                            },
                        },
                    }]));
                    child.emit('close', 0, null);
                });
                return child;
            });

        const { createComposeRuntime } = await import('./composeRuntime');
        const runtime = createComposeRuntime({
            composeFilePath: '/tmp/topology/docker-compose.yml',
            composeProjectName: 'happier-stress-run',
            cwd: '/repo/root',
        });

        await expect(runtime.attestServicesUseImage?.({
            services: ['api'],
            imageName: 'happier-stress-compose-server-repo-a-source-a',
            expectedLabels: {
                'happier.stress.owner': 'stress-harness',
                'happier.stress.repo-root': 'repo-a',
                'happier.stress.image-fingerprint': 'source-a',
            },
        })).rejects.toThrow('did not start from the expected stress image');
    });

    it('captures streamed stdout for inspection commands', async () => {
        spawnMock.mockReset();
        spawnMock.mockImplementation(() => {
            const child = createChildProcess();
            queueMicrotask(() => {
                child.stdout.emit('data', '{"Service":"api"}\n');
                child.stdout.emit('data', '{"Service":"worker"}\n');
                child.emit('close', 0, null);
            });
            return child;
        });

        const { createComposeRuntime } = await import('./composeRuntime');
        const runtime = createComposeRuntime({
            composeFilePath: '/tmp/topology/docker-compose.yml',
            composeProjectName: 'happier-stress-run',
            cwd: '/repo/root',
        });

        await expect(runtime.ps()).resolves.toBe('{"Service":"api"}\n{"Service":"worker"}');
    });

    it('supports service start and stop orchestration for scenario-controlled disruptions', async () => {
        spawnMock.mockReset();
        spawnMock
            .mockImplementationOnce(() => {
                const child = createChildProcess();
                queueMicrotask(() => {
                    child.emit('close', 0, null);
                });
                return child;
            })
            .mockImplementationOnce(() => {
                const child = createChildProcess();
                queueMicrotask(() => {
                    child.emit('close', 0, null);
                });
                return child;
            });

        const { createComposeRuntime } = await import('./composeRuntime');
        const runtime = createComposeRuntime({
            composeFilePath: '/tmp/topology/docker-compose.yml',
            composeProjectName: 'happier-stress-run',
            cwd: '/repo/root',
        });

        await expect(runtime.stop?.('worker')).resolves.toBeUndefined();
        await expect(runtime.start?.('worker')).resolves.toBeUndefined();

        expect(spawnMock).toHaveBeenNthCalledWith(
            1,
            'docker',
            [
                'compose',
                '-f',
                '/tmp/topology/docker-compose.yml',
                '-p',
                'happier-stress-run',
                'stop',
                'worker',
            ],
            expect.objectContaining({ cwd: '/repo/root' }),
        );
        expect(spawnMock).toHaveBeenNthCalledWith(
            2,
            'docker',
            [
                'compose',
                '-f',
                '/tmp/topology/docker-compose.yml',
                '-p',
                'happier-stress-run',
                'start',
                'worker',
            ],
            expect.objectContaining({ cwd: '/repo/root' }),
        );
    });

    it('supports direct container stop operations for replica-specific failover scenarios', async () => {
        spawnMock.mockReset();
        spawnMock.mockImplementation(() => {
            const child = createChildProcess();
            queueMicrotask(() => {
                child.emit('close', 0, null);
            });
            return child;
        });

        const { createComposeRuntime } = await import('./composeRuntime');
        const runtime = createComposeRuntime({
            composeFilePath: '/tmp/topology/docker-compose.yml',
            composeProjectName: 'happier-stress-run',
            cwd: '/repo/root',
        });

        await expect(runtime.stopContainer?.('container-123')).resolves.toBeUndefined();

        expect(spawnMock).toHaveBeenCalledWith(
            'docker',
            ['stop', 'container-123'],
            expect.objectContaining({ cwd: '/repo/root' }),
        );
    });

    it('supports direct container kill operations for crash-recovery scenarios', async () => {
        spawnMock.mockReset();
        spawnMock.mockImplementation(() => {
            const child = createChildProcess();
            queueMicrotask(() => {
                child.emit('close', 0, null);
            });
            return child;
        });

        const { createComposeRuntime } = await import('./composeRuntime');
        const runtime = createComposeRuntime({
            composeFilePath: '/tmp/topology/docker-compose.yml',
            composeProjectName: 'happier-stress-run',
            cwd: '/repo/root',
        });

        await expect(runtime.killContainer?.('container-123')).resolves.toBeUndefined();

        expect(spawnMock).toHaveBeenCalledWith(
            'docker',
            ['kill', 'container-123'],
            expect.objectContaining({ cwd: '/repo/root' }),
        );
    });

    it('lists task-owned compose projects from labeled docker resources', async () => {
        spawnMock.mockReset();
        spawnMock
            .mockImplementationOnce(() => {
                const child = createChildProcess();
                queueMicrotask(() => {
                    child.stdout.emit(
                        'data',
                        'happier-stress-old-a\tstress-harness\trepo-fingerprint\n'
                        + 'happier-stress-foreign-owner\tanother-harness\trepo-fingerprint\n'
                        + 'happier-stress-foreign-repo\tstress-harness\tother-repo\n'
                        + 'happier-stress-prefix-only\t\t\n',
                    );
                    child.emit('close', 0, null);
                });
                return child;
            })
            .mockImplementationOnce(() => {
                const child = createChildProcess();
                queueMicrotask(() => {
                    child.stdout.emit('data', 'happier-stress-network-only\tstress-harness\trepo-fingerprint\n');
                    child.emit('close', 0, null);
                });
                return child;
            })
            .mockImplementationOnce(() => {
                const child = createChildProcess();
                queueMicrotask(() => {
                    child.stdout.emit('data', '\n');
                    child.emit('close', 0, null);
                });
                return child;
            });

        const { createComposeRuntime } = await import('./composeRuntime');
        const runtime = createComposeRuntime({
            composeFilePath: '/tmp/topology/docker-compose.yml',
            composeProjectName: 'happier-stress-run',
            cwd: '/repo/root',
        });

        await expect(runtime.listOwnedProjects('repo-fingerprint')).resolves.toEqual(['happier-stress-old-a']);
        expect(spawnMock).toHaveBeenNthCalledWith(
            1,
            'docker',
            [
                'ps',
                '-a',
                '--format',
                '{{.Label "com.docker.compose.project"}}\t{{.Label "happier.stress.owner"}}\t{{.Label "happier.stress.repo-root"}}',
            ],
            expect.objectContaining({ cwd: '/repo/root' }),
        );
    });

    it('removes task-owned compose project resources by compose project label', async () => {
        spawnMock.mockReset();
        spawnMock
            .mockImplementationOnce(() => {
                const child = createChildProcess();
                queueMicrotask(() => {
                    child.stdout.emit('data', 'container-1\ncontainer-2\n');
                    child.emit('close', 0, null);
                });
                return child;
            })
            .mockImplementationOnce(() => {
                const child = createChildProcess();
                queueMicrotask(() => {
                    child.emit('close', 0, null);
                });
                return child;
            })
            .mockImplementationOnce(() => {
                const child = createChildProcess();
                queueMicrotask(() => {
                    child.stdout.emit('data', 'network-1\n');
                    child.emit('close', 0, null);
                });
                return child;
            })
            .mockImplementationOnce(() => {
                const child = createChildProcess();
                queueMicrotask(() => {
                    child.emit('close', 0, null);
                });
                return child;
            })
            .mockImplementationOnce(() => {
                const child = createChildProcess();
                queueMicrotask(() => {
                    child.stdout.emit('data', 'volume-1\n');
                    child.emit('close', 0, null);
                });
                return child;
            })
            .mockImplementationOnce(() => {
                const child = createChildProcess();
                queueMicrotask(() => {
                    child.emit('close', 0, null);
                });
                return child;
            });

        const { createComposeRuntime } = await import('./composeRuntime');
        const runtime = createComposeRuntime({
            composeFilePath: '/tmp/topology/docker-compose.yml',
            composeProjectName: 'happier-stress-run',
            cwd: '/repo/root',
        });

        await expect(runtime.removeProjectResources('happier-stress-old-a')).resolves.toBeUndefined();

        expect(spawnMock).toHaveBeenNthCalledWith(
            1,
            'docker',
            ['ps', '-a', '--filter', 'label=com.docker.compose.project=happier-stress-old-a', '-q'],
            expect.objectContaining({ cwd: '/repo/root' }),
        );
        expect(spawnMock).toHaveBeenNthCalledWith(
            2,
            'docker',
            ['rm', '-f', '-v', 'container-1', 'container-2'],
            expect.objectContaining({ cwd: '/repo/root' }),
        );
        expect(spawnMock).toHaveBeenNthCalledWith(
            3,
            'docker',
            ['network', 'ls', '--filter', 'label=com.docker.compose.project=happier-stress-old-a', '-q'],
            expect.objectContaining({ cwd: '/repo/root' }),
        );
        expect(spawnMock).toHaveBeenNthCalledWith(
            4,
            'docker',
            ['network', 'rm', 'network-1'],
            expect.objectContaining({ cwd: '/repo/root' }),
        );
        expect(spawnMock).toHaveBeenNthCalledWith(
            5,
            'docker',
            ['volume', 'ls', '--filter', 'label=com.docker.compose.project=happier-stress-old-a', '-q'],
            expect.objectContaining({ cwd: '/repo/root' }),
        );
        expect(spawnMock).toHaveBeenNthCalledWith(
            6,
            'docker',
            ['volume', 'rm', 'volume-1'],
            expect.objectContaining({ cwd: '/repo/root' }),
        );
    });

    it('retries transient Docker Desktop API failures before giving up', async () => {
        spawnMock.mockReset();
        spawnMock
            .mockImplementationOnce(() => {
                const child = createChildProcess();
                queueMicrotask(() => {
                    child.stderr.emit(
                        'data',
                        'request returned 500 Internal Server Error for API route and version http://%2FUsers%2Fme%2F.docker%2Frun%2Fdocker.sock/v1.53/containers/json, check if the server supports the requested API version\n',
                    );
                    child.emit('close', 1, null);
                });
                return child;
            })
            .mockImplementationOnce(() => {
                const child = createChildProcess();
                queueMicrotask(() => {
                    child.stdout.emit('data', 'container-1\n');
                    child.emit('close', 0, null);
                });
                return child;
            })
            .mockImplementationOnce(() => {
                const child = createChildProcess();
                queueMicrotask(() => {
                    child.emit('close', 0, null);
                });
                return child;
            })
            .mockImplementationOnce(() => {
                const child = createChildProcess();
                queueMicrotask(() => {
                    child.emit('close', 0, null);
                });
                return child;
            })
            .mockImplementationOnce(() => {
                const child = createChildProcess();
                queueMicrotask(() => {
                    child.emit('close', 0, null);
                });
                return child;
            });

        const { createComposeRuntime } = await import('./composeRuntime');
        const runtime = createComposeRuntime({
            composeFilePath: '/tmp/topology/docker-compose.yml',
            composeProjectName: 'happier-stress-run',
            cwd: '/repo/root',
        });

        await expect(runtime.removeProjectResources('happier-stress-old-a')).resolves.toBeUndefined();

        expect(spawnMock).toHaveBeenNthCalledWith(
            1,
            'docker',
            ['ps', '-a', '--filter', 'label=com.docker.compose.project=happier-stress-old-a', '-q'],
            expect.objectContaining({ cwd: '/repo/root' }),
        );
        expect(spawnMock).toHaveBeenNthCalledWith(
            2,
            'docker',
            ['ps', '-a', '--filter', 'label=com.docker.compose.project=happier-stress-old-a', '-q'],
            expect.objectContaining({ cwd: '/repo/root' }),
        );
    });

    it('retries transient docker spawn EBADF failures before giving up', async () => {
        spawnMock.mockReset();
        spawnMock
            .mockImplementationOnce(() => {
                const child = createChildProcess();
                queueMicrotask(() => {
                    const error = new Error('spawn EBADF') as Error & { code?: string };
                    error.code = 'EBADF';
                    child.emit('error', error);
                });
                return child;
            })
            .mockImplementationOnce(() => {
                const child = createChildProcess();
                queueMicrotask(() => {
                    child.stdout.emit('data', 'container-1\n');
                    child.emit('close', 0, null);
                });
                return child;
            })
            .mockImplementationOnce(() => {
                const child = createChildProcess();
                queueMicrotask(() => {
                    child.emit('close', 0, null);
                });
                return child;
            })
            .mockImplementationOnce(() => {
                const child = createChildProcess();
                queueMicrotask(() => {
                    child.emit('close', 0, null);
                });
                return child;
            })
            .mockImplementationOnce(() => {
                const child = createChildProcess();
                queueMicrotask(() => {
                    child.emit('close', 0, null);
                });
                return child;
            });

        const { createComposeRuntime } = await import('./composeRuntime');
        const runtime = createComposeRuntime({
            composeFilePath: '/tmp/topology/docker-compose.yml',
            composeProjectName: 'happier-stress-run',
            cwd: '/repo/root',
        });

        await expect(runtime.removeProjectResources('happier-stress-old-a')).resolves.toBeUndefined();

        expect(spawnMock).toHaveBeenNthCalledWith(
            1,
            'docker',
            ['ps', '-a', '--filter', 'label=com.docker.compose.project=happier-stress-old-a', '-q'],
            expect.objectContaining({ cwd: '/repo/root' }),
        );
        expect(spawnMock).toHaveBeenNthCalledWith(
            2,
            'docker',
            ['ps', '-a', '--filter', 'label=com.docker.compose.project=happier-stress-old-a', '-q'],
            expect.objectContaining({ cwd: '/repo/root' }),
        );
    });
});
