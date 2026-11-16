import { describe, expect, it } from 'vitest';
import { z } from '../../zodRuntimePolicy.js';
import { createManagedMachinePresetPreparationBuildInputV1Schema, ManagedMachinePresetPreparationBuildInputV1Schema } from './managedMachinePresetPreparationBuildInputV1.js';

const input = {
  launch: { provider: { pluginId: 'test.compute', localId: 'guest' }, schemaVersion: 1,
    choices: { image: 'ubuntu', architecture: 'x64', region: 'test-region' } },
  cli: { identity: 'home-payload:actual-payload-digest', versionId: '0.3.0',
    binaryPath: '$HOME/.happier/cli/versions/local-payload/happier',
    installScript: 'set -eu\nstage="$(mktemp -d)"\ntar -xf happier-cli-payload.tar.gz -C "$stage"\n',
    files: [{ path: 'happier-cli-payload.tar.gz', contentsBase64: 'cGF5bG9hZA==' },
      { path: 'payload-support.bin', contentsBase64: 'AAECAwQ=' }] },
};

describe('native preparation build input trust boundary', () => {
  it('specializes provider choices without opening nested executable input objects', () => {
    const schema = createManagedMachinePresetPreparationBuildInputV1Schema(z.strictObject({
      image: z.string(), target: z.strictObject({ arch: z.string() }),
    }));
    const specialized = { ...input, launch: { ...input.launch, choices: { image: 'ubuntu', target: { arch: 'x64' } } },
      setupScript: 'exec /opt/happier/bin/happier machine effect-internal --operation-id=image-build' };
    expect(schema.parse(specialized)).toEqual(specialized);
    expect(schema.safeParse({ ...specialized, launch: { ...specialized.launch,
      choices: { ...specialized.launch.choices, undeclared: true } } }).success).toBe(false);
    expect(schema.safeParse({ ...specialized, launch: { ...specialized.launch,
      choices: { ...specialized.launch.choices, target: { arch: 'x64', credential: 'private' } } } }).success).toBe(false);
  });

  it('preserves configured native choices, exact installation script and every supplied file', () => {
    expect(ManagedMachinePresetPreparationBuildInputV1Schema.parse(input)).toEqual(input);
    const signedPublicInstall = { ...input, cli: { ...input.cli, identity: 'public-release:0.3.10',
      versionId: '0.3.10', files: [], installScript: 'set -eu\ncurl --fail https://releases.example/cli.tar.gz -o cli.tar.gz\n' } };
    expect(ManagedMachinePresetPreparationBuildInputV1Schema.parse(signedPublicInstall)).toEqual(signedPublicInstall);
    const withPreparation = { ...input, setupScript: "printf '%s\\n' '{\"v\":1}' | /opt/happier/bin/happier machine effect-internal --operation-id=image-build\n" };
    expect(ManagedMachinePresetPreparationBuildInputV1Schema.parse(withPreparation)).toEqual(withPreparation);
  });

  it('refuses private identity, credential and setup carriers at every closed build-input object', () => {
    for (const privateInput of [
      { ...input, setup: { secretRefs: { v: 1, bindings: { TOKEN: { ref: 'private-secret' } } } } },
      { ...input, setupPreparation: { basis: { kind: 'preparation', operationId: 'image-build' }, recipes: [] } },
      { ...input, launch: { ...input.launch, name: 'Private preset name' } },
      { ...input, launch: { ...input.launch, credentials: [] } },
      { ...input, launch: { ...input.launch, provider: { ...input.launch.provider, accountToken: 'private-token' } } },
      { ...input, cli: { ...input.cli, accountToken: 'private-token' } },
      { ...input, cli: { ...input.cli, files: [{ ...input.cli.files[0]!, credentials: 'private-token' }] } },
    ]) expect(ManagedMachinePresetPreparationBuildInputV1Schema.safeParse(privateInput).success).toBe(false);
    expect(ManagedMachinePresetPreparationBuildInputV1Schema.safeParse({ ...input,
      cli: { ...input.cli, files: [{ path: 'incomplete-file' }] } }).success).toBe(false);
  });
});
