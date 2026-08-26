import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildManagedLimaCreateArgs,
  buildManagedLimaEditArgs,
  resolveManagedLimaProfile,
} from './profiles.mjs';

test('managed Lima balanced profile is bounded, mount-free, ARM64 VZ, and containerd-free', () => {
  const profile = resolveManagedLimaProfile('balanced');

  assert.deepEqual(profile, {
    schemaVersion: 1,
    name: 'balanced',
    vmType: 'vz',
    arch: 'aarch64',
    template: 'ubuntu-24.04',
    diskImageFormat: 'raw',
    cpus: 10,
    memoryGiB: 24,
    diskGiB: 160,
    containerd: 'none',
    mountNone: true,
    rosetta: false,
    portForwards: [
      { guestStart: 52005, guestEnd: 54004, hostStart: 52005, hostEnd: 54004 },
      { guestStart: 18081, guestEnd: 20080, hostStart: 18081, hostEnd: 20080 },
    ],
  });

  assert.deepEqual(buildManagedLimaCreateArgs({ instance: 'happier-agent-primary', profile }), [
    'create',
    '--name', 'happier-agent-primary',
    '--tty=false',
    '--vm-type', 'vz',
    '--arch', 'aarch64',
    '--cpus', '10',
    '--memory', '24',
    '--disk', '160',
    '--containerd', 'none',
    '--mount-none',
    '--set', '.vmOpts.vz.diskImageFormat = "raw"',
    '--set', '.ssh.forwardAgent = false',
    '--set', '.vmOpts.vz.rosetta.enabled = false | .vmOpts.vz.rosetta.binfmt = false',
    '--set', '.portForwards = [{"guestPortRange":[52005,54004],"hostPortRange":[52005,54004]},{"guestPortRange":[18081,20080],"hostPortRange":[18081,20080]}]',
    'template:ubuntu-24.04',
  ]);
});

test('managed Lima worker profile can render a native x86_64 guest without changing resource policy', () => {
  const profile = resolveManagedLimaProfile('worker-balanced', { architecture: 'x86_64' });

  assert.equal(profile.arch, 'x86_64');
  assert.equal(profile.cpus, 8);
  assert.equal(profile.memoryGiB, 24);
  assert.deepEqual(
    buildManagedLimaCreateArgs({ instance: 'happier-worker-intel', profile }).slice(0, 8),
    ['create', '--name', 'happier-worker-intel', '--tty=false', '--vm-type', 'vz', '--arch', 'x86_64'],
  );
});

test('managed Lima edit args update only mutable retained-instance settings', () => {
  assert.deepEqual(buildManagedLimaEditArgs({
    instance: 'happier-agent-primary',
    profile: resolveManagedLimaProfile('small'),
  }), [
    'edit',
    '--tty=false',
    '--cpus', '8',
    '--memory', '16',
    '--disk', '160',
    '--mount-none',
    '--set', '.ssh.forwardAgent = false',
    '--set', '.vmOpts.vz.rosetta.enabled = false | .vmOpts.vz.rosetta.binfmt = false',
    '--set', '.containerd.user = false | .containerd.system = false',
    '--set', '.portForwards = [{"guestPortRange":[52005,54004],"hostPortRange":[52005,54004]},{"guestPortRange":[18081,20080],"hostPortRange":[18081,20080]}]',
    'happier-agent-primary',
  ]);
});

test('managed Lima profile rejects unknown profiles and unsafe instance names', () => {
  assert.throws(() => resolveManagedLimaProfile('enormous'), /unknown managed Lima profile/);
  assert.throws(
    () => resolveManagedLimaProfile('worker-balanced', { architecture: 'riscv64' }),
    /unsupported managed Lima architecture/,
  );
  assert.throws(
    () => buildManagedLimaCreateArgs({ instance: '../escape', profile: resolveManagedLimaProfile('small') }),
    /invalid managed Lima instance name/,
  );
});
