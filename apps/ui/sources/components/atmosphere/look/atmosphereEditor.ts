import * as React from 'react';
import type {
  HomeAtmosphere,
  AtmospherePresentation,
  AtmospherePlace,
} from '@happier-dev/protocol/account/settings/accountSettings';
import { useSetting } from '@/sync/store/hooks';
import { useSettingActionFeedback } from '@/components/settings/shell/useSettingActionFeedback';
import type { SettingsDeclarationTargetV1 } from '@happier-dev/protocol/actions/settingsDeclarationActionFamily';
import type { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { readSettingWithPreview, useSettingPreview } from '@/sync/store/settingsPreview';
import { useAtmosphere } from '../useAtmosphere';

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
  update(edit: (current: AtmospherePresentation) => AtmospherePresentation): void;
  /** Present only for app atmospheres; a public profile never edits these private preferences. */
  showOn?: readonly AtmospherePlace[];
  setShowOn?(places: readonly AtmospherePlace[]): void;
  /** A gesture draft, withdrawn on release/cancellation; never a Settings write. */
  preview?: (edit: ((current: AtmospherePresentation) => AtmospherePresentation) | undefined) => void;
  /** Per-picture controls edit the available picture on screen; value retains the saved selection. */
  shownPictureRef?: AtmospherePresentation['picture']['ref'];
  pictureActions?: AtmospherePictureActions;
  sameAsHome?: boolean;
  resetToHome?: () => void;
}>;

/** Each edit starts from the latest Account snapshot at invocation; the declaration owns the full value. */
export function useHomeAtmosphereValueEditor(): AtmosphereEditor &
  Readonly<{
    value: HomeAtmosphere;
    updateHome(edit: (current: HomeAtmosphere) => HomeAtmosphere): void;
  }> {
  const value = useSetting('homeAtmosphere');
  const setPreview = useSettingPreview('homeAtmosphere');
  const { setSetting, isCurrent } = useSettingActionFeedback();
  return React.useMemo(() => {
    const updateHome = (edit: (current: HomeAtmosphere) => HomeAtmosphere) => {
      if (!isCurrent(homeAtmosphereSetting)) return;
      return setSetting(homeAtmosphereSetting, edit(readSettingWithPreview('homeAtmosphere')));
    };
    return {
      value,
      showOn: value.showOn,
      setShowOn: places => setSetting({ anchor: 'appearance.atmosphereShowOn' }, [...places]),
      preview: edit => {
        const current = readSettingWithPreview('homeAtmosphere');
        setPreview(edit ? { ...current, ...edit(current) } : undefined);
      },
      updateHome,
      update: (edit) =>
        updateHome((current) => ({ ...current, ...edit(current) })),
    };
  }, [isCurrent, setSetting, setPreview, value]);
}

/** Picture controls decorate the one value/mutation owner with the actual shown presentation. */
export function useHomeAtmosphereEditor(): ReturnType<typeof useHomeAtmosphereValueEditor> {
  const editor = useHomeAtmosphereValueEditor();
  const atmosphere = useAtmosphere('home');
  const shownPictureRef = atmosphere.source === 'picture' ? atmosphere.picture.ref : editor.value.picture.ref;
  return React.useMemo(() => ({ ...editor, shownPictureRef }), [editor, shownPictureRef]);
}
