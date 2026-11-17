import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';
import { AccountPetOriginV1Schema, type AccountPetLibraryEntryV1 } from './accountLibrary.js';
import { computeSha256HexDigest } from '../crypto/canonicalDigest.js';

/** Portable identity shares the Account origin fields, with a closed envelope at the sharing seam. */
export const PetRegistryOriginV1Schema = lazyZodSchema(() =>
  z.strictObject(AccountPetOriginV1Schema.def.options[3].def.shape));
export type PetRegistryOriginV1 = z.infer<typeof PetRegistryOriginV1Schema>;

/** Preserve the Account package digest byte contract for server admission and portable imports. */
export function computeAccountPetPackageDigestV1(
  manifest: AccountPetLibraryEntryV1['manifest'],
  spritesheetBytes: Uint8Array,
): string {
  const header = new TextEncoder().encode(`${JSON.stringify(manifest, Object.keys(manifest).sort())}\n`);
  const bytes = new Uint8Array(header.byteLength + spritesheetBytes.byteLength);
  bytes.set(header);
  bytes.set(spritesheetBytes, header.byteLength);
  return `sha256:${computeSha256HexDigest(bytes)}`;
}

/** Import and face consumers agree on identity without relying on another Account's local id. */
export function findMatchingAccountPetV1(
  pets: readonly AccountPetLibraryEntryV1[],
  identity: PetRegistryOriginV1 | Readonly<{ kind: 'digest'; digest: string }>,
): AccountPetLibraryEntryV1 | undefined {
  return pets.find(pet => identity.kind === 'digest' ? pet.digest === identity.digest
    : pet.origin.kind === 'registry' && pet.origin.sourceId === identity.sourceId && pet.origin.itemId === identity.itemId);
}
