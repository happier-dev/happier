import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ca } from '../../../../../apps/ui/sources/text/translations/ca';
import { en } from '../../../../../apps/ui/sources/text/translations/en';
import { es } from '../../../../../apps/ui/sources/text/translations/es';
import { it as itLocale } from '../../../../../apps/ui/sources/text/translations/it';
import { ja } from '../../../../../apps/ui/sources/text/translations/ja';
import { pl } from '../../../../../apps/ui/sources/text/translations/pl';
import { pt } from '../../../../../apps/ui/sources/text/translations/pt';
import { ru } from '../../../../../apps/ui/sources/text/translations/ru';
import { zhHans } from '../../../../../apps/ui/sources/text/translations/zh-Hans';
import { zhHant } from '../../../../../apps/ui/sources/text/translations/zh-Hant';
import { repoRootDir } from '../paths';

import {
  collectDesktopPetOverlayContractDriftIssues,
  collectPetDataUriPersistenceIssues,
  collectPetTranslationParityIssues,
  petDataUriPersistenceGuardRelativeDirs,
  readPetDataUriGuardSources,
} from './petValidationGuards';

const translationsByLocale = {
  en,
  ru,
  pl,
  es,
  it: itLocale,
  pt,
  ca,
  'zh-Hans': zhHans,
  'zh-Hant': zhHant,
  ja,
};

describe('pet validation guards', () => {
  it('reports only missing required pet translation leaves', () => {
    expect(collectPetTranslationParityIssues({
      requiredKeys: ['petOverlay.tray.openSession', 'petOverlay.status.running'],
      translationsByLocale: {
        en: {
          petOverlay: {
            tray: { openSession: 'Open session' },
            status: { running: 'Running' },
          },
        },
        es: {
          petOverlay: {
            tray: { openSession: 'Abrir sesión' },
          },
        },
      },
    })).toEqual(['es missing petOverlay.status.running']);
  });

  it('flags data URI literals while allowing raw base64 payload fields', () => {
    expect(collectPetDataUriPersistenceIssues([
      {
        filePath: 'apps/server/sources/app/pets/accountPetLibraryPersistence.ts',
        source: "const data = 'iVBORw0KGgo=';",
      },
      {
        filePath: 'apps/server/sources/app/pets/accountPetLibraryPersistence.ts',
        source: "const uri = 'data:image/png;base64,iVBORw0KGgo=';",
      },
    ])).toEqual([
      'apps/server/sources/app/pets/accountPetLibraryPersistence.ts stores or serializes data URI payloads',
    ]);
  });

  it('reports TypeScript and Rust desktop overlay bridge drift by registered command', () => {
    expect(collectDesktopPetOverlayContractDriftIssues({
      tsBridgeSource: 'startDesktopPetOverlayDragSession desktop_pet_overlay_start_drag_session',
      rustOverlaySource: 'pub fn desktop_pet_overlay_start_drag_session() {} "desktop_pet_overlay_start_drag_session" PET_OVERLAY_WINDOW_LABEL desktop_pet_overlay_window_state_changed desktop_pet_overlay_interaction_result',
      rustLibSource: 'pet_overlay::desktop_pet_overlay_start_drag_session',
    })).toEqual([
      'TypeScript bridge missing applyDesktopPetOverlayDragDelta',
      'TypeScript bridge missing command desktop_pet_overlay_apply_drag_delta',
      'Rust overlay missing command fn desktop_pet_overlay_apply_drag_delta',
      'Rust invoke handler missing desktop_pet_overlay_apply_drag_delta',
      'Rust caller validation missing desktop_pet_overlay_apply_drag_delta',
      'TypeScript bridge missing releaseDesktopPetOverlayDragVelocity',
      'TypeScript bridge missing command desktop_pet_overlay_release_drag_velocity',
      'Rust overlay missing command fn desktop_pet_overlay_release_drag_velocity',
      'Rust invoke handler missing desktop_pet_overlay_release_drag_velocity',
      'Rust caller validation missing desktop_pet_overlay_release_drag_velocity',
      'TypeScript bridge missing applyDesktopPetOverlayMomentumDelta',
      'TypeScript bridge missing command desktop_pet_overlay_apply_momentum_delta',
      'Rust overlay missing command fn desktop_pet_overlay_apply_momentum_delta',
      'Rust invoke handler missing desktop_pet_overlay_apply_momentum_delta',
      'Rust caller validation missing desktop_pet_overlay_apply_momentum_delta',
      'TypeScript bridge missing endDesktopPetOverlayDragSession',
      'TypeScript bridge missing command desktop_pet_overlay_end_drag_session',
      'Rust overlay missing command fn desktop_pet_overlay_end_drag_session',
      'Rust invoke handler missing desktop_pet_overlay_end_drag_session',
      'Rust caller validation missing desktop_pet_overlay_end_drag_session',
      'TypeScript bridge missing setDesktopPetOverlayInputLocked',
      'TypeScript bridge missing command desktop_pet_overlay_set_input_locked',
      'Rust overlay missing command fn desktop_pet_overlay_set_input_locked',
      'Rust invoke handler missing desktop_pet_overlay_set_input_locked',
      'Rust caller validation missing desktop_pet_overlay_set_input_locked',
      'Rust caller validation missing MAIN_WINDOW_LABEL for desktop_pet_overlay_set_input_locked',
      'TypeScript bridge missing resetDesktopPetOverlayPosition',
      'TypeScript bridge missing command desktop_pet_overlay_reset_position',
      'Rust overlay missing command fn desktop_pet_overlay_reset_position',
      'Rust invoke handler missing desktop_pet_overlay_reset_position',
      'Rust caller validation missing desktop_pet_overlay_reset_position',
      'Rust caller validation missing MAIN_WINDOW_LABEL for desktop_pet_overlay_reset_position',
      'TypeScript bridge missing showMainWindowFromDesktopPetOverlay',
      'TypeScript bridge missing command desktop_pet_overlay_show_main_window',
      'Rust overlay missing command fn desktop_pet_overlay_show_main_window',
      'Rust invoke handler missing desktop_pet_overlay_show_main_window',
      'Rust caller validation missing desktop_pet_overlay_show_main_window',
      'TypeScript bridge missing syncDesktopPetOverlayElementMetrics',
      'TypeScript bridge missing command desktop_pet_overlay_sync_element_metrics',
      'Rust overlay missing command fn desktop_pet_overlay_sync_element_metrics',
      'Rust invoke handler missing desktop_pet_overlay_sync_element_metrics',
      'Rust caller validation missing desktop_pet_overlay_sync_element_metrics',
      'TypeScript bridge missing event desktop_pet_overlay_window_state_changed',
      'TypeScript bridge missing event desktop_pet_overlay_interaction_result',
    ]);
  });

  it('keeps pet command palette and overlay tray copy represented in every locale', () => {
    expect(collectPetTranslationParityIssues({ translationsByLocale })).toEqual([]);
  });

  it('keeps account pet persistence paths free of data URI payloads', async () => {
    const sources = await readPetDataUriGuardSources({ rootDir: repoRootDir() });

    expect(collectPetDataUriPersistenceIssues(sources)).toEqual([]);
  });

  it('guards both synced settings and account pet persistence from data URI payloads', () => {
    expect(petDataUriPersistenceGuardRelativeDirs).toEqual(expect.arrayContaining([
      'apps/server/sources/app/pets',
      'apps/ui/sources/sync/domains/settings',
      'apps/ui/sources/sync/domains/state',
      'apps/ui/sources/sync/store/domains',
    ]));
  });

  it('keeps desktop pet overlay bridge command contracts aligned across TypeScript and Rust', async () => {
    const root = repoRootDir();
    const [tsBridgeSource, rustOverlaySource, rustLibSource] = await Promise.all([
      readFile(join(root, 'apps/ui/sources/components/pets/desktop/bridge/desktopPetOverlayBridge.ts'), 'utf8'),
      readFile(join(root, 'apps/ui/src-tauri/src/pet_overlay.rs'), 'utf8'),
      readFile(join(root, 'apps/ui/src-tauri/src/lib.rs'), 'utf8'),
    ]);

    expect(collectDesktopPetOverlayContractDriftIssues({
      tsBridgeSource,
      rustOverlaySource,
      rustLibSource,
    })).toEqual([]);
  });
});
