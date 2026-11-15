import { createManualSystemTaskRunner } from '@/dev/testkit/harness/manualSystemTaskRunner';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';
import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { useConfiguredSshHostSuggestions } from './useConfiguredSshHostSuggestions';

afterEach(() => { standardCleanup(); });

describe('useConfiguredSshHostSuggestions', () => {
    it('loads through the system task bridge and preserves stale suggestions while refreshing', async () => {
        const harness = createManualSystemTaskRunner();
        const rendered = await renderHook(() => useConfiguredSshHostSuggestions({
            runner: harness.runner,
        }));
        expect(harness.bridge.start).toHaveBeenCalled();

        await act(async () => {
            harness.emitResult('personal-home-task-1', {
                protocolVersion: 1,
                taskId: 'personal-home-task-1',
                ok: true,
                data: [
                    {
                        id: 'ssh-config:devbox',
                        alias: 'devbox',
                        hostname: '10.0.0.5',
                        port: 2222,
                        username: 'ubuntu',
                        source: 'ssh-config',
                        sourcePath: '/Users/test/.ssh/config',
                    },
                ],
            });
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(rendered.getCurrent().suggestions.map((suggestion) => suggestion.alias)).toEqual(['devbox']);
        expect(rendered.getCurrent().loading).toBe(false);

        await act(async () => {
            await rendered.getCurrent().refresh();
        });

        expect(rendered.getCurrent().refreshing).toBe(true);
        expect(rendered.getCurrent().suggestions.map((suggestion) => suggestion.alias)).toEqual(['devbox']);

        await act(async () => {
            harness.emitResult('personal-home-task-2', {
                protocolVersion: 1,
                taskId: 'personal-home-task-2',
                ok: false,
                error: {
                    code: 'discovery_failed',
                    message: 'Could not read SSH config.',
                },
            });
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(rendered.getCurrent().refreshing).toBe(false);
        expect(rendered.getCurrent().suggestions.map((suggestion) => suggestion.alias)).toEqual(['devbox']);
        expect(rendered.getCurrent().error?.message).toContain('Could not read SSH config');
    });
});
