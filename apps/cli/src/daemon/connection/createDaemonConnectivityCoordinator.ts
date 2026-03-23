import type { ManagedConnectionState } from '@happier-dev/connection-supervisor';

type ManagedDaemonConnectivityResource = Readonly<{
  name: string;
  pause: () => void | Promise<void>;
  resume: () => void | Promise<void>;
}>;

type DaemonConnectivityCoordinator = Readonly<{
  applyState: (state: ManagedConnectionState) => Promise<void>;
  registerResource: (resource: ManagedDaemonConnectivityResource) => Promise<void>;
}>;

function shouldBePaused(phase: ManagedConnectionState['phase']): boolean {
  return phase !== 'online';
}

export function createDaemonConnectivityCoordinator(params: Readonly<{
  resources: ReadonlyArray<ManagedDaemonConnectivityResource>;
}>): DaemonConnectivityCoordinator {
  const resources = [...params.resources];
  let paused = false;
  let initialized = false;

  async function applyTransition(nextPaused: boolean): Promise<void> {
    if (nextPaused) {
      for (const resource of resources) {
        await resource.pause();
      }
      return;
    }

    for (const resource of resources) {
      await resource.resume();
    }
  }

  return {
    async applyState(state: ManagedConnectionState): Promise<void> {
      const nextPaused = shouldBePaused(state.phase);
      if (initialized && nextPaused === paused) {
        return;
      }

      initialized = true;
      paused = nextPaused;
      await applyTransition(nextPaused);
    },
    async registerResource(resource: ManagedDaemonConnectivityResource): Promise<void> {
      resources.push(resource);
      if (!initialized) {
        return;
      }
      if (paused) {
        await resource.pause();
        return;
      }
      await resource.resume();
    },
  };
}
