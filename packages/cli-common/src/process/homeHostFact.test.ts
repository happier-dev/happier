import { describe, expect, it } from 'vitest';

import { detectHomeHostFactFromSystem, resolvePreferredHostName } from './homeHostFact.js';

function fixture(
  platform: 'linux' | 'darwin' | 'win32',
  files: Record<string, string> = {},
  outputs: readonly string[] = [],
) {
  let nextOutput = 0;
  return {
    platform,
    machineName: 'Studio',
    readText: async (path: string) => {
      if (!(path in files)) throw new Error('missing');
      return files[path];
    },
    listPowerSupplies: async () => Object.keys(files)
      .filter((path) => path.startsWith('/sys/class/power_supply/'))
      .map((path) => path.split('/')[4]),
    runTool: async () => outputs[nextOutput++] ?? '',
  };
}

describe('Home host OS fact', () => {
  it('classifies portable and stationary Linux chassis and stays unknown when container facts are absent', async () => {
    expect(await detectHomeHostFactFromSystem(fixture('linux', { '/sys/class/dmi/id/chassis_type': '10\n' })))
      .toEqual({ kind: 'known', machineName: 'Studio', platform: 'linux', mobility: 'portable' });
    expect(await detectHomeHostFactFromSystem(fixture('linux', { '/sys/class/dmi/id/chassis_type': '3\n' })))
      .toEqual({ kind: 'known', machineName: 'Studio', platform: 'linux', mobility: 'stationary' });
    expect(await detectHomeHostFactFromSystem(fixture('linux'))).toEqual({ kind: 'unknown' });
    expect(await detectHomeHostFactFromSystem(fixture('linux', {
      '/.dockerenv': '',
      '/sys/class/dmi/id/chassis_type': '3\n',
    }))).toEqual({ kind: 'unknown' });
    expect(await detectHomeHostFactFromSystem(fixture('linux', {
      '/proc/1/cgroup': '0::/kubepods.slice/pod123\n',
      '/sys/class/dmi/id/chassis_type': '3\n',
    }))).toEqual({ kind: 'unknown' });
    expect(await detectHomeHostFactFromSystem(fixture('linux', {
      '/proc/1/cgroup': '0::/\n',
      '/proc/1/mountinfo': '12 3 0:1 / / rw - overlay overlay rw,upperdir=/var/lib/containerd/pod123\n',
      '/sys/class/dmi/id/chassis_type': '3\n',
    }))).toEqual({ kind: 'unknown' });
  });

  it('recognizes a Linux host with Docker child mounts', async () => {
    expect(await detectHomeHostFactFromSystem(fixture('linux', {
      '/proc/1/mountinfo': [
        '12 3 8:1 / / rw - ext4 /dev/sda1 rw',
        '13 12 0:1 / /var/lib/docker/overlay2/id/merged rw - overlay overlay rw,upperdir=/var/lib/docker/overlay2/id/diff',
      ].join('\n'),
      '/sys/class/dmi/id/chassis_type': '23\n',
    }))).toEqual({ kind: 'known', machineName: 'Studio', platform: 'linux', mobility: 'stationary' });
  });

  it('keeps a Linux container unknown when a namespace file is backed by container storage', async () => {
    expect(await detectHomeHostFactFromSystem(fixture('linux', {
      '/proc/1/mountinfo': '13 12 8:1 /var/lib/docker/containers/id/hostname /etc/hostname rw - ext4 /dev/sda1 rw\n',
      '/sys/class/dmi/id/chassis_type': '23\n',
    }))).toEqual({ kind: 'unknown' });
  });

  it('uses a Linux battery as portable evidence when DMI is unavailable', async () => {
    expect(await detectHomeHostFactFromSystem(fixture('linux', { '/sys/class/power_supply/BAT0/type': 'Battery\n' })))
      .toMatchObject({ kind: 'known', mobility: 'portable' });
    expect(await detectHomeHostFactFromSystem(fixture('linux', {
      '/sys/class/power_supply/mouse/type': 'Battery\n',
      '/sys/class/power_supply/mouse/scope': 'Device\n',
    }))).toEqual({ kind: 'unknown' });
    expect(await detectHomeHostFactFromSystem(fixture('linux', { '/sys/class/dmi/id/chassis_type': '11\n' })))
      .toMatchObject({ mobility: 'portable' });
    for (const chassis of [13, 28]) {
      expect(await detectHomeHostFactFromSystem(fixture('linux', { '/sys/class/dmi/id/chassis_type': `${chassis}\n` })))
        .toMatchObject({ mobility: 'stationary' });
    }
  });

  it('uses internal battery evidence on recognized macOS models and keeps failed or unrecognized probes unknown', async () => {
    expect(await detectHomeHostFactFromSystem(fixture('darwin', {}, ['MacBookPro18,1\n', '-InternalBattery-0\n'])))
      .toMatchObject({ kind: 'known', mobility: 'portable' });
    expect(await detectHomeHostFactFromSystem(fixture('darwin', {}, ['Macmini9,1\n', 'No batteries available\n'])))
      .toMatchObject({ kind: 'known', mobility: 'stationary' });
    expect(await detectHomeHostFactFromSystem(fixture('darwin', {}, ['Mac16,2\n', '-InternalBattery-0 (id=123)\n'])))
      .toMatchObject({ kind: 'known', mobility: 'portable' });
    for (const batteryOutput of ['', 'No batteries available\n', "Now drawing from 'AC Power'\n", "Now drawing from 'Battery Power'\n"]) {
      expect(await detectHomeHostFactFromSystem(fixture('darwin', {}, ['Mac16,2\n', batteryOutput])))
        .toMatchObject({ kind: 'known', mobility: 'stationary' });
    }
    expect(await detectHomeHostFactFromSystem(fixture('darwin', {}, ['MacBookPro18,1\n', 'No batteries available\n'])))
      .toMatchObject({ kind: 'known', mobility: 'stationary' });
    for (const model of ['Mac16,2', 'MacBookPro18,1', 'iMac21,1']) {
      expect(await detectHomeHostFactFromSystem({
        ...fixture('darwin'),
        runTool: async (command: string) => {
          if (command === 'sysctl') return model;
          throw new Error('pmset failed');
        },
      })).toEqual({ kind: 'unknown' });
    }
    expect(await detectHomeHostFactFromSystem(fixture('darwin', {}, ['VirtualMac\n', '-InternalBattery-0\n'])))
      .toEqual({ kind: 'unknown' });
  });

  it('uses Windows enclosure codes and battery evidence without platform guessing', async () => {
    expect(await detectHomeHostFactFromSystem(fixture('win32', {}, ['[9]'])))
      .toMatchObject({ kind: 'known', mobility: 'portable' });
    expect(await detectHomeHostFactFromSystem(fixture('win32', {}, ['[3]'])))
      .toMatchObject({ kind: 'known', mobility: 'stationary' });
    expect(await detectHomeHostFactFromSystem(fixture('win32', {}, ['[]', '1'])))
      .toMatchObject({ kind: 'known', mobility: 'portable' });
    expect(await detectHomeHostFactFromSystem(fixture('win32', {}, ['[]', '0'])))
      .toEqual({ kind: 'unknown' });
  });

  it('resolves the same preferred Mac machine name for daemon and Home facts', async () => {
    expect(await resolvePreferredHostName({ platform: 'darwin', fallback: 'studio.local',
      runTool: async (_command, args) => args[1] === 'HostName' ? '' : args[1] === 'LocalHostName' ? 'Studio' : 'Other',
    })).toBe('Studio');
  });

  it('stops trying macOS name tools when the owning probe is cancelled', async () => {
    const controller = new AbortController();
    let calls = 0;
    await expect(resolvePreferredHostName({
      platform: 'darwin', fallback: 'studio.local', signal: controller.signal,
      runTool: async () => {
        calls += 1;
        controller.abort();
        throw new Error('probe cancelled');
      },
    })).rejects.toThrow('probe cancelled');
    expect(calls).toBe(1);
  });
});
