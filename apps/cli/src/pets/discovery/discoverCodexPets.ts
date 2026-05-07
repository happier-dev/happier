import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import {
  PET_DISCOVERY_LIMITS_V1,
  type PetDiscoveryDiagnosticV1,
  type PetPackageValidationResultV1,
} from '@happier-dev/protocol';

import type { PetDiscoveryRoot } from './resolveCodexPetRoots';
import { createPetSourceKey } from './createPetSourceKey';
import type { PetPackageDiscoveryCacheEntry } from './petPackageDiscoveryCache';
import { validatePetPackage } from '../validation/validatePetPackage';

type PetPackageValidator = (input: Readonly<{ packagePath: string; signal?: AbortSignal }>) => Promise<PetPackageValidationResultV1>;

const INTERNAL_VALIDATION_ERROR: PetPackageValidationResultV1 = {
  ok: false,
  issues: [{ code: 'internal_error', message: 'Pet package validation failed.' }],
};

export type DiscoverCodexPetsResult = Readonly<{
  ok: true;
  pets: PetPackageDiscoveryCacheEntry[];
  diagnostics: PetDiscoveryDiagnosticV1[];
  partial: boolean;
}>;

function diagnostic(input: Readonly<{
  code: PetDiscoveryDiagnosticV1['code'];
  message: string;
  rootPath?: string;
  packagePath?: string;
}>): PetDiscoveryDiagnosticV1 {
  return {
    code: input.code,
    message: input.message,
    ...(input.rootPath ? { rootPath: input.rootPath } : {}),
    ...(input.packagePath ? { packagePath: input.packagePath } : {}),
  };
}

function isOverTimeBudget(startedAt: number, maxDiscoveryWallClockMs: number, nowMs: () => number): boolean {
  return nowMs() - startedAt > maxDiscoveryWallClockMs;
}

async function validatePackageWithinBudget(input: Readonly<{
  packagePath: string;
  validatePackage: PetPackageValidator;
  timeoutMs: number;
}>): Promise<Readonly<{ type: 'validated'; validation: PetPackageValidationResultV1 }> | Readonly<{ type: 'timeout' }>> {
  if (input.timeoutMs <= 0) return { type: 'timeout' };

  const controller = new AbortController();
  let timedOut = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const validationPromise = input.validatePackage({
    packagePath: input.packagePath,
    signal: controller.signal,
  })
    .then((validation) => (
      timedOut || controller.signal.aborted
        ? { type: 'timeout' as const }
        : { type: 'validated' as const, validation }
    ))
    .catch(() => (
      timedOut || controller.signal.aborted
        ? { type: 'timeout' as const }
        : { type: 'validated' as const, validation: INTERNAL_VALIDATION_ERROR }
    ));
  const timeoutPromise = new Promise<Readonly<{ type: 'timeout' }>>((resolveTimeout) => {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      resolveTimeout({ type: 'timeout' });
      controller.abort();
    }, input.timeoutMs);
    timeoutHandle.unref?.();
  });

  const result = await Promise.race([validationPromise, timeoutPromise]);
  if (timeoutHandle) clearTimeout(timeoutHandle);
  if (result.type === 'timeout' && !controller.signal.aborted) {
    timedOut = true;
    controller.abort();
  }
  return result;
}

export async function discoverCodexPets(input: Readonly<{
  roots: readonly PetDiscoveryRoot[];
  maxPetsPerRoot?: number;
  maxDiscoveryWallClockMs?: number;
  nowMs?: () => number;
  validatePackage?: PetPackageValidator;
}>): Promise<DiscoverCodexPetsResult> {
  const maxPetsPerRoot = input.maxPetsPerRoot ?? PET_DISCOVERY_LIMITS_V1.maxPetsPerRoot;
  const maxDiscoveryWallClockMs = input.maxDiscoveryWallClockMs ?? PET_DISCOVERY_LIMITS_V1.maxDiscoveryWallClockMs;
  const nowMs = input.nowMs ?? Date.now;
  const packageValidator = input.validatePackage ?? validatePetPackage;
  const startedAt = nowMs();
  const pets: PetPackageDiscoveryCacheEntry[] = [];
  const diagnostics: PetDiscoveryDiagnosticV1[] = [];
  let partial = false;

  for (const root of input.roots) {
    if (isOverTimeBudget(startedAt, maxDiscoveryWallClockMs, nowMs)) {
      diagnostics.push(diagnostic({ code: 'time_budget_exceeded', message: 'Pet discovery time budget exceeded.', rootPath: root.petsPath }));
      partial = true;
      break;
    }

    const entries = await readdir(root.petsPath, { withFileTypes: true }).catch(() => null);
    if (!entries) {
      diagnostics.push(diagnostic({ code: 'root_unreadable', message: 'Pet root is not readable.', rootPath: root.petsPath }));
      continue;
    }

    const packageEntries = entries
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .sort((a, b) => a.name.localeCompare(b.name));
    const boundedEntries = packageEntries.slice(0, maxPetsPerRoot);
    if (packageEntries.length > boundedEntries.length) {
      diagnostics.push(diagnostic({ code: 'pet_limit_exceeded', message: 'Pet root exceeded the per-root pet discovery budget.', rootPath: root.petsPath }));
      partial = true;
    }

    for (const entry of boundedEntries) {
      const packagePath = join(root.petsPath, entry.name);
      const elapsedMs = nowMs() - startedAt;
      const validationResult = await validatePackageWithinBudget({
        packagePath,
        validatePackage: packageValidator,
        timeoutMs: maxDiscoveryWallClockMs - elapsedMs,
      });
      if (validationResult.type === 'timeout') {
        diagnostics.push(diagnostic({ code: 'time_budget_exceeded', message: 'Pet discovery time budget exceeded.', rootPath: root.petsPath, packagePath }));
        partial = true;
        return { ok: true, pets, diagnostics, partial };
      }

      const validation = validationResult.validation;
      if (validation.ok) {
        const sourceKey = root.kind === 'happierManagedLocal'
          ? createPetSourceKey(['happierManagedLocal', packagePath, validation.digest])
          : createPetSourceKey([root.kind, root.homeKind, packagePath, validation.digest]);
        pets.push({
          sourceKey,
          petId: validation.manifest.id,
          displayName: validation.manifest.displayName,
          packageFormat: validation.packageFormat,
          manifest: validation.manifest,
          source: root.kind === 'happierManagedLocal'
            ? {
              kind: 'happierManagedLocal',
              packagePath,
              sourceKey,
            }
            : {
              kind: 'detectedCodexHome',
              homeKind: root.homeKind,
              homePath: root.homePath,
              packagePath,
              sourceKey,
            },
          packagePath,
          spritesheetPath: validation.spritesheetPath,
          mediaType: validation.mediaType,
          digest: validation.digest,
          sizeBytes: validation.sizeBytes,
        });
      } else {
        diagnostics.push(diagnostic({ code: 'invalid_package', message: 'Pet package failed validation.', rootPath: root.petsPath, packagePath }));
      }

      if (isOverTimeBudget(startedAt, maxDiscoveryWallClockMs, nowMs)) {
        diagnostics.push(diagnostic({ code: 'time_budget_exceeded', message: 'Pet discovery time budget exceeded.', rootPath: root.petsPath }));
        partial = true;
        return { ok: true, pets, diagnostics, partial };
      }
    }
  }

  return { ok: true, pets, diagnostics, partial };
}
