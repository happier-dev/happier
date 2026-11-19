import { z } from '../../zodRuntimePolicy.js';

import {
  defineProtocolLiteral,
  defineProtocolObject,
  defineProtocolString,
  defineProtocolUnion,
} from '../actions/protocolComposableSchema.js';
import { asProtocolZod } from '../actions/internalProtocolZodAdapter.js';
import { PluginIdSchema } from '../pluginId.js';

const Identity = defineProtocolString({ minLength: 1, pattern: '.*\\S.*' });
const InstallSource = defineProtocolUnion([
  defineProtocolLiteral('npm'),
  defineProtocolLiteral('archive'),
  defineProtocolLiteral('localPath'),
  defineProtocolLiteral('git'),
]);

export const ManagedPluginSourceCustodyV1ProtocolSchema = defineProtocolObject({
  kind: defineProtocolLiteral('managed'),
  immutableGenerationId: Identity,
  installSource: InstallSource,
}, { policy: 'closed' });
const CliVersionRoot = defineProtocolObject({
  kind: defineProtocolLiteral('cli_version_root'),
  versionRootId: Identity,
}, { policy: 'closed' });
const PinnedRunnerSnapshot = defineProtocolObject({
  kind: defineProtocolLiteral('pinned_runner_snapshot'),
  snapshotId: Identity,
}, { policy: 'closed' });
const BundledSourceDeclaration = defineProtocolObject({
  kind: defineProtocolLiteral('source_declaration'),
  packageName: Identity,
}, { policy: 'closed' });
export const BundledPackagedRuntimeCustodyV1ProtocolSchema = defineProtocolUnion([
  CliVersionRoot,
  PinnedRunnerSnapshot,
  BundledSourceDeclaration,
]);
export const BundledFirstPartyPluginSourceCustodyV1ProtocolSchema = defineProtocolObject({
  kind: defineProtocolLiteral('bundled_first_party'),
  packagedRuntime: BundledPackagedRuntimeCustodyV1ProtocolSchema,
}, { policy: 'closed' });
export const DevelopmentPluginSourceCustodyV1ProtocolSchema = defineProtocolObject({
  kind: defineProtocolLiteral('development'),
  registeredRootId: Identity,
}, { policy: 'closed' });
export const AccountReleasePluginSourceCustodyV1ProtocolSchema = defineProtocolObject({
  kind: defineProtocolLiteral('account_release'),
  pluginId: PluginIdSchema,
  version: Identity,
  archiveDigestSha256: defineProtocolString({ pattern: '^sha256:[a-f0-9]{64}$' }),
}, { policy: 'closed' });

/** Canonical validator-neutral durable source-custody contract. */
export const PluginSourceCustodyV1ProtocolSchema = defineProtocolUnion([
  ManagedPluginSourceCustodyV1ProtocolSchema,
  BundledFirstPartyPluginSourceCustodyV1ProtocolSchema,
  DevelopmentPluginSourceCustodyV1ProtocolSchema,
  AccountReleasePluginSourceCustodyV1ProtocolSchema,
]);

function trimIdentity(value: unknown): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

function trimCustodyIdentityStrings(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const value = input as Readonly<Record<string, unknown>>;
  if (value.kind === 'managed') {
    return { ...value, immutableGenerationId: trimIdentity(value.immutableGenerationId) };
  }
  if (value.kind === 'development') {
    return { ...value, registeredRootId: trimIdentity(value.registeredRootId) };
  }
  if (value.kind === 'account_release') return { ...value,
    pluginId: trimIdentity(value.pluginId), version: trimIdentity(value.version),
    archiveDigestSha256: trimIdentity(value.archiveDigestSha256),
  };
  if (value.kind !== 'bundled_first_party' || !value.packagedRuntime
    || typeof value.packagedRuntime !== 'object' || Array.isArray(value.packagedRuntime)) return input;
  const packaged = value.packagedRuntime as Readonly<Record<string, unknown>>;
  return {
    ...value,
    packagedRuntime: packaged.kind === 'cli_version_root'
      ? { ...packaged, versionRootId: trimIdentity(packaged.versionRootId) }
      : packaged.kind === 'source_declaration' ? { ...packaged,
          packageName: trimIdentity(packaged.packageName),
        }
      : { ...packaged, snapshotId: trimIdentity(packaged.snapshotId) },
  };
}

export const ManagedPluginSourceCustodyV1Schema = asProtocolZod(
  ManagedPluginSourceCustodyV1ProtocolSchema,
);
export const BundledPackagedRuntimeCustodyV1Schema = asProtocolZod(
  BundledPackagedRuntimeCustodyV1ProtocolSchema,
);
export const BundledFirstPartyPluginSourceCustodyV1Schema = asProtocolZod(
  BundledFirstPartyPluginSourceCustodyV1ProtocolSchema,
);
export const DevelopmentPluginSourceCustodyV1Schema = asProtocolZod(
  DevelopmentPluginSourceCustodyV1ProtocolSchema,
);
export const PluginSourceCustodyV1Schema = asProtocolZod(
  PluginSourceCustodyV1ProtocolSchema,
);
export const AccountReleasePluginSourceCustodyV1Schema = asProtocolZod(AccountReleasePluginSourceCustodyV1ProtocolSchema);
export type AccountReleasePluginSourceCustodyV1 = z.infer<typeof AccountReleasePluginSourceCustodyV1Schema>;

export type ManagedPluginSourceCustodyV1 = z.infer<typeof ManagedPluginSourceCustodyV1Schema>;
export type BundledPackagedRuntimeCustodyV1 = z.infer<typeof BundledPackagedRuntimeCustodyV1Schema>;
export type BundledFirstPartyPluginSourceCustodyV1 = z.infer<typeof BundledFirstPartyPluginSourceCustodyV1Schema>;
export type DevelopmentPluginSourceCustodyV1 = z.infer<typeof DevelopmentPluginSourceCustodyV1Schema>;
export type PluginSourceCustodyV1 = z.infer<typeof PluginSourceCustodyV1Schema>;

export function normalizePluginSourceCustodyV1(input: unknown): PluginSourceCustodyV1 {
  const custody = PluginSourceCustodyV1Schema.parse(trimCustodyIdentityStrings(input));
  return custody.kind === 'bundled_first_party'
    ? Object.freeze({ ...custody, packagedRuntime: Object.freeze({ ...custody.packagedRuntime }) })
    : Object.freeze({ ...custody });
}

export function pluginSourceCustodyV1Equal(left: PluginSourceCustodyV1, right: PluginSourceCustodyV1): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'managed' && right.kind === 'managed') {
    return left.immutableGenerationId === right.immutableGenerationId && left.installSource === right.installSource;
  }
  if (left.kind === 'development' && right.kind === 'development') {
    return left.registeredRootId === right.registeredRootId;
  }
  if (left.kind === 'account_release' && right.kind === 'account_release') {
    return left.pluginId === right.pluginId && left.version === right.version
      && left.archiveDigestSha256 === right.archiveDigestSha256;
  }
  if (left.kind !== 'bundled_first_party' || right.kind !== 'bundled_first_party') return false;
  if (left.packagedRuntime.kind !== right.packagedRuntime.kind) return false;
  return left.packagedRuntime.kind === 'source_declaration' && right.packagedRuntime.kind === 'source_declaration'
      ? left.packagedRuntime.packageName === right.packagedRuntime.packageName
    : left.packagedRuntime.kind === 'cli_version_root' && right.packagedRuntime.kind === 'cli_version_root'
    ? left.packagedRuntime.versionRootId === right.packagedRuntime.versionRootId
    : left.packagedRuntime.kind === 'pinned_runner_snapshot'
      && right.packagedRuntime.kind === 'pinned_runner_snapshot'
      && left.packagedRuntime.snapshotId === right.packagedRuntime.snapshotId;
}
