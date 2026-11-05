import * as React from 'react';
import type {
  HomeAtmosphere,
  AtmospherePresentation,
  AtmospherePlace,
} from '@happier-dev/protocol/account/settings/accountSettings';
import { useSetting } from '@/sync/store/hooks';
import { getStorage } from '@/sync/domains/state/storageStore';
import { useSettingActionFeedback } from '@/components/settings/shell/useSettingActionFeedback';
import type { SettingsDeclarationTargetV1 } from '@happier-dev/protocol/actions/settingsDeclarationActionFamily';
import type { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';

const homeAtmosphereSetting = { anchor: 'appearance.homeAtmosphere' } as const;

/** Acquisition remains an admitted Settings operation bound to this editor's captured owner. */
export type AtmospherePictureActions = Readonly<{
  target: Extract<SettingsDeclarationTargetV1, { kind: 'project' | 'public_profile_draft' }>;
  executorOptions?: NonNullable<Parameters<typeof useMountedActionExecution>[1]>['executorOptions'];
}>;

/**
 * What the Look panel edits: the value it shows and one write that applies an edit (from
 * `atmosphereEdits`) to the latest stored value. Home and new session write the Account's Home
 * atmosphere; a project screen passes its project override's editor instead (the project owner).
 */
export type AtmosphereEditor = Readonly<{
  value: AtmospherePresentation;
  showOn?: readonly AtmospherePlace[];
  setShowOn?(places: readonly AtmospherePlace[]): void;
  update(edit: (current: AtmospherePresentation) => AtmospherePresentation): void;
  pictureActions?: AtmospherePictureActions;
  sameAsHome?: boolean;
  resetToHome?: () => void;
}>;

/** Each edit starts from the latest Account snapshot at invocation; the declaration owns the full value. */
export function useHomeAtmosphereEditor(): AtmosphereEditor &
  Readonly<{
    value: HomeAtmosphere;
    updateHome(edit: (current: HomeAtmosphere) => HomeAtmosphere): void;
  }> {
  const value = useSetting('homeAtmosphere');
  const { setSetting, isCurrent } = useSettingActionFeedback();
  return React.useMemo(() => {
    const updateHome = (edit: (current: HomeAtmosphere) => HomeAtmosphere) => {
      if (!isCurrent(homeAtmosphereSetting)) return;
      return setSetting(homeAtmosphereSetting, edit(getStorage().getState().settings.homeAtmosphere));
    };
    return {
      value,
      showOn: value.showOn,
      setShowOn: places => setSetting({ anchor: 'appearance.atmosphereShowOn' }, [...places]),
      updateHome,
      update: (edit) =>
        updateHome((current) => ({ ...current, ...edit(current) })),
    };
  }, [isCurrent, setSetting, value]);
}
