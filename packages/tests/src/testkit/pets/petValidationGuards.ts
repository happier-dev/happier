import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

export type PetTranslationRoots = Readonly<Record<string, Record<string, unknown>>>;

export const requiredPetTranslationKeys = [
  'commandPalette.pets.category',
  'commandPalette.pets.wakeTitle',
  'commandPalette.pets.wakeSubtitle',
  'commandPalette.pets.tuckTitle',
  'commandPalette.pets.tuckSubtitle',
  'commandPalette.pets.resetPositionTitle',
  'commandPalette.pets.resetPositionSubtitle',
  'commandPalette.pets.chooseTitle',
  'commandPalette.pets.chooseSubtitle',
  'commandPalette.pets.refreshCodexTitle',
  'commandPalette.pets.refreshCodexSubtitle',
  'settingsPets.overlayTrayTitle',
  'settingsPets.overlayDismissAction',
  'settingsPets.overlayQuickReplyPlaceholder',
  'settingsPets.overlayQuickReplyAction',
  'settingsPets.overlayTuckAction',
  'settingsPets.overlayStatusRunning',
  'settingsPets.overlayStatusWaiting',
  'settingsPets.overlayStatusReview',
  'settingsPets.overlayStatusFailed',
] as const;

export const petDataUriPersistenceGuardRelativeDirs = [
  'packages/protocol/src/pets',
  'apps/server/sources/app/pets',
  'apps/ui/sources/sync/domains/settings',
  'apps/ui/sources/sync/domains/state',
  'apps/ui/sources/sync/store/domains',
  'apps/ui/sources/components/pets/source',
  'apps/ui/sources/components/settings/pets',
] as const;

export const desktopPetOverlayCommandContracts = [
  {
    tsSymbol: 'startDesktopPetOverlayDragSession',
    rustCommand: 'desktop_pet_overlay_start_drag_session',
    registeredCaller: 'PET_OVERLAY_WINDOW_LABEL',
  },
  {
    tsSymbol: 'applyDesktopPetOverlayDragDelta',
    rustCommand: 'desktop_pet_overlay_apply_drag_delta',
    registeredCaller: 'PET_OVERLAY_WINDOW_LABEL',
  },
  {
    tsSymbol: 'releaseDesktopPetOverlayDragVelocity',
    rustCommand: 'desktop_pet_overlay_release_drag_velocity',
    registeredCaller: 'PET_OVERLAY_WINDOW_LABEL',
  },
  {
    tsSymbol: 'applyDesktopPetOverlayMomentumDelta',
    rustCommand: 'desktop_pet_overlay_apply_momentum_delta',
    registeredCaller: 'PET_OVERLAY_WINDOW_LABEL',
  },
  {
    tsSymbol: 'endDesktopPetOverlayDragSession',
    rustCommand: 'desktop_pet_overlay_end_drag_session',
    registeredCaller: 'PET_OVERLAY_WINDOW_LABEL',
  },
  {
    tsSymbol: 'setDesktopPetOverlayInputLocked',
    rustCommand: 'desktop_pet_overlay_set_input_locked',
    registeredCaller: 'MAIN_WINDOW_LABEL',
  },
  {
    tsSymbol: 'resetDesktopPetOverlayPosition',
    rustCommand: 'desktop_pet_overlay_reset_position',
    registeredCaller: 'MAIN_WINDOW_LABEL',
  },
  {
    tsSymbol: 'showMainWindowFromDesktopPetOverlay',
    rustCommand: 'desktop_pet_overlay_show_main_window',
    registeredCaller: 'PET_OVERLAY_WINDOW_LABEL',
  },
  {
    tsSymbol: 'syncDesktopPetOverlayElementMetrics',
    rustCommand: 'desktop_pet_overlay_sync_element_metrics',
    registeredCaller: 'PET_OVERLAY_WINDOW_LABEL',
  },
] as const;

export const desktopPetOverlayEventContracts = [
  'desktop_pet_overlay_window_state_changed',
  'desktop_pet_overlay_interaction_result',
] as const;

export type PetDataUriGuardSource = Readonly<{
  filePath: string;
  source: string;
}>;

export type DesktopPetOverlayContractSources = Readonly<{
  tsBridgeSource: string;
  rustOverlaySource: string;
  rustLibSource: string;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readTranslationValue(root: Record<string, unknown>, key: string): unknown {
  return key.split('.').reduce<unknown>((current, segment) => (
    isRecord(current) ? current[segment] : undefined
  ), root);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function collectSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectSourceFiles(fullPath));
    } else if (
      /\.(ts|tsx|rs)$/.test(entry.name)
      && !/\.(test|spec)\.(ts|tsx)$/.test(entry.name)
    ) {
      files.push(fullPath);
    }
  }
  return files;
}

export function collectPetTranslationParityIssues(params: Readonly<{
  translationsByLocale: PetTranslationRoots;
  requiredKeys?: readonly string[];
}>): string[] {
  const requiredKeys = params.requiredKeys ?? requiredPetTranslationKeys;
  const issues: string[] = [];
  for (const [locale, root] of Object.entries(params.translationsByLocale)) {
    for (const key of requiredKeys) {
      const value = readTranslationValue(root, key);
      if (typeof value !== 'string' && typeof value !== 'function') {
        issues.push(`${locale} missing ${key}`);
      }
    }
  }
  return issues;
}

export function collectPetDataUriPersistenceIssues(
  sources: readonly PetDataUriGuardSource[],
): string[] {
  const dataUriPattern = /\bdata:(?:image|application|text)\/[a-z0-9.+-]+(?:;[a-z0-9=.+-]+)*,/iu;
  return sources
    .filter((source) => dataUriPattern.test(source.source))
    .map((source) => `${source.filePath} stores or serializes data URI payloads`);
}

export async function readPetDataUriGuardSources(params: Readonly<{
  rootDir: string;
  relativeDirs?: readonly string[];
}>): Promise<PetDataUriGuardSource[]> {
  const relativeDirs = params.relativeDirs ?? petDataUriPersistenceGuardRelativeDirs;
  const files = (await Promise.all(
    relativeDirs.map((dir) => collectSourceFiles(join(params.rootDir, dir))),
  )).flat();

  return await Promise.all(files.map(async (filePath) => ({
    filePath: relative(params.rootDir, filePath),
    source: await readFile(filePath, 'utf8'),
  })));
}

export function collectDesktopPetOverlayContractDriftIssues(
  sources: DesktopPetOverlayContractSources,
): string[] {
  const issues: string[] = [];

  for (const contract of desktopPetOverlayCommandContracts) {
    if (!sources.tsBridgeSource.includes(contract.tsSymbol)) {
      issues.push(`TypeScript bridge missing ${contract.tsSymbol}`);
    }
    if (!sources.tsBridgeSource.includes(contract.rustCommand)) {
      issues.push(`TypeScript bridge missing command ${contract.rustCommand}`);
    }
    if (!new RegExp(`\\bpub\\s+fn\\s+${escapeRegExp(contract.rustCommand)}\\b`, 'u').test(sources.rustOverlaySource)) {
      issues.push(`Rust overlay missing command fn ${contract.rustCommand}`);
    }
    if (!new RegExp(`\\bpet_overlay::${escapeRegExp(contract.rustCommand)}\\b`, 'u').test(sources.rustLibSource)) {
      issues.push(`Rust invoke handler missing ${contract.rustCommand}`);
    }
    if (!sources.rustOverlaySource.includes(`"${contract.rustCommand}"`)) {
      issues.push(`Rust caller validation missing ${contract.rustCommand}`);
    }
    if (!sources.rustOverlaySource.includes(contract.registeredCaller)) {
      issues.push(`Rust caller validation missing ${contract.registeredCaller} for ${contract.rustCommand}`);
    }
  }

  for (const event of desktopPetOverlayEventContracts) {
    if (!sources.tsBridgeSource.includes(event)) {
      issues.push(`TypeScript bridge missing event ${event}`);
    }
    if (!sources.rustOverlaySource.includes(event)) {
      issues.push(`Rust overlay missing event ${event}`);
    }
  }

  return issues;
}
