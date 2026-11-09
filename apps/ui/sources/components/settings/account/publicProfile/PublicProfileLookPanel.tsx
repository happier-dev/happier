import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { AtmospherePicture } from '@happier-dev/brand/atmosphere';
import type { AtmospherePresentation } from '@happier-dev/protocol/account/settings/accountSettings';
import type { PublicProfilePreparedAtmosphereV1 } from '@happier-dev/protocol/account/publicProfileAtmosphere';
import type { AtmosphereEditor } from '@/components/atmosphere/look/atmosphereEditor';
import { LookBackdropControls } from '@/components/atmosphere/look/LookPanel';
import { useAtmospherePictureAcquisition } from '@/components/atmosphere/look/PicturePicker';
import { useStoredPicture } from '@/components/atmosphere/look/usePictureBytes';
import { pictureStore } from '@/components/atmosphere/pictureStore';
import { preparePublicProfileAtmosphere } from '@/components/atmosphere/preparePublicProfileAtmosphere';
import { useAtmospherePictureCatalog } from '@/components/atmosphere/useAtmospherePictureCatalog';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { useSettingActionFeedback } from '@/components/settings/shell/useSettingActionFeedback';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { t } from '@/text';
import { PublicProfilePanelHeader } from './PublicProfilePanelHeader';
import { usePublicProfileAtmospherePreview, usePublicProfileAtmospherePreviewValue } from '@/sync/store/settingsPreview';

export type PublicProfileLookPreparation =
  | Readonly<{ status: 'ready'; prepared: PublicProfilePreparedAtmosphereV1 }>
  | Readonly<{ status: 'unavailable'; reason: 'account_retired' | 'picture_unavailable' | 'picture_normalization_failed' }>;

/**
 * Look for a public profile: Home's backdrop controls (source, the library and this device's pictures,
 * effect, fade, strength, layout) over the profile's private candidate, without the global glass rows.
 * Every edit goes through Settings bound to this captured draft; nothing here writes Home, a project
 * or glass. The footer explains what Apply publishes about the chosen picture, or how to recover one
 * that isn't on this device.
 */
export const PublicProfileLookPanel = React.memo(function PublicProfileLookPanel(
  props: Readonly<{
    serverId: string;
    value: AtmospherePresentation;
    onChange: (next: AtmospherePresentation) => void;
    testID?: string;
  }>,
) {
  const { serverId, value } = props;
  const preview = usePublicProfileAtmospherePreviewValue(serverId);
  const setPreview = usePublicProfileAtmospherePreview(serverId);
  const pictures = useAtmospherePictureCatalog();
  const { binding } = useServerCredentialAccountScopeBinding(serverId);
  // The captured draft: edits start from the latest candidate, including one not yet re-rendered.
  const latest = React.useRef({ value, onChange: props.onChange, binding });
  latest.current = { ...latest.current, onChange: props.onChange, binding };
  if (latest.current.value !== value) latest.current.value = value;
  const mounted = React.useRef(true);
  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const updateDraft = React.useCallback((edit: (current: AtmospherePresentation) => AtmospherePresentation) => {
    const next = edit(latest.current.value);
    if (next === latest.current.value) return;
    latest.current.value = next;
    latest.current.onChange(next);
  }, []);
  const pictureActions = React.useMemo<NonNullable<AtmosphereEditor['pictureActions']>>(() => ({
    target: { kind: 'public_profile_draft', serverId },
    executorOptions: {
      publicProfileAtmosphereDraft: {
        serverId,
        isCurrent: () => mounted.current && Boolean(latest.current.binding?.isCurrent()),
        read: () => latest.current.value,
        update: updateDraft,
      },
    },
  }), [serverId, updateDraft]);
  const { setSetting, isCurrent } = useSettingActionFeedback({ serverId, executorOptions: pictureActions.executorOptions });
  const update = React.useCallback((edit: (current: AtmospherePresentation) => AtmospherePresentation) => {
    const setting = { anchor: 'appearance.homeAtmosphere', target: pictureActions.target };
    if (!isCurrent(setting)) return;
    const next = edit(latest.current.value);
    if (next === latest.current.value) return;
    return setSetting(setting, next);
  }, [isCurrent, pictureActions.target, setSetting]);
  const previewEdit = React.useCallback<NonNullable<AtmosphereEditor['preview']>>(edit => {
    setPreview(edit ? edit(latest.current.value) : undefined);
  }, [setPreview]);
  const editor = React.useMemo<AtmosphereEditor>(() => ({ value: preview ?? value, update, pictureActions, preview: previewEdit }), [value, preview, update, pictureActions, previewEdit]);
  return (
    <View style={styles.panel} testID={props.testID}>
      <PublicProfilePanelHeader title={t('publicIdentity.look.title')} description={t('publicIdentity.look.description')} />
      <LookBackdropControls editor={editor} pictures={pictures} />
      {value.source === 'picture' ? (
        <LookFooter pictureRef={value.picture.ref} pictures={pictures} pictureActions={pictureActions} />
      ) : null}
    </View>
  );
});

function LookFooter(
  props: Readonly<{
    pictureRef: AtmospherePresentation['picture']['ref'];
    pictures: readonly AtmospherePicture[];
    pictureActions: NonNullable<AtmosphereEditor['pictureActions']>;
  }>,
) {
  const ref = props.pictureRef;
  const stored = useStoredPicture(ref.kind === 'user' ? ref.localId : null);
  if (ref.kind === 'builtin') {
    const picture = props.pictures.find((candidate) => candidate.id === ref.id);
    if (!picture) return null;
    return (
      <FooterLine icon="image">
        {t('publicIdentity.look.creditOnPage', { credit: `${picture.credit.author} · ${picture.credit.source}` })}
      </FooterLine>
    );
  }
  if (stored.status === 'loading') return null;
  if (stored.status === 'present') {
    return <FooterLine icon="eye-slash">{t('publicIdentity.look.devicePictureDisclosure')}</FooterLine>;
  }
  return <MissingPicture pictureActions={props.pictureActions} />;
}

function FooterLine(props: Readonly<{ icon: 'image' | 'eye-slash'; children: string }>) {
  const { theme } = useUnistyles();
  return (
    <View style={styles.footer} testID="public-profile-look-footer">
      <View style={styles.footerGlyph}>
        <Icon name={props.icon} size={ICON_SIZE.sm} color={theme.colors.text.secondary} />
      </View>
      <Text variant="meta" style={styles.footerText}>{props.children}</Text>
    </View>
  );
}

/** The chosen device picture isn't here: say so and offer the next step; the candidate keeps naming it. */
function MissingPicture(props: Readonly<{ pictureActions: NonNullable<AtmosphereEditor['pictureActions']> }>) {
  const { theme } = useUnistyles();
  const { add } = useAtmospherePictureAcquisition(props.pictureActions);
  return (
    <View style={styles.footer} testID="public-profile-look-footer">
      <View style={styles.footerGlyph}>
        <Icon name="image" size={ICON_SIZE.sm} color={theme.colors.text.secondary} />
      </View>
      <View style={styles.missing}>
        <Text variant="meta" emphasis="medium" style={styles.missingTitle}>
          {t('publicIdentity.look.missingTitle', { name: t('settingsAppearance.glassControls.yourPicture') })}
        </Text>
        <Text variant="meta" style={styles.footerText}>{t('publicIdentity.look.missingBody')}</Text>
        <View style={styles.missingAction}>
          <RoundButton
            testID="public-profile-look-choose-picture"
            size="small"
            display="secondary"
            title={t('publicIdentity.look.choosePicture')}
            onPress={() => {
              void add();
            }}
          />
        </View>
      </View>
    </View>
  );
}

/**
 * Prepares the reviewed public copy of a Look candidate at review time, through the canonical local
 * preparer (exact selected pixels and frozen effective settings; nothing is uploaded here). A
 * preparation for another Home, or one whose Account binding retires meanwhile, reports `account_retired`.
 */
export function usePreparePublicProfileLook(serverId: string) {
  const pictures = useAtmospherePictureCatalog();
  const { binding } = useServerCredentialAccountScopeBinding(serverId);
  const latest = React.useRef({ pictures, binding });
  latest.current = { pictures, binding };
  return React.useCallback(
    async (input: Readonly<{ serverId: string; value: AtmospherePresentation }>): Promise<PublicProfileLookPreparation> => {
      const bound = latest.current.binding;
      const isCurrent = () =>
        input.serverId === serverId && bound !== null && bound.isCurrent() && latest.current.binding === bound;
      const result = await preparePublicProfileAtmosphere({
        presentation: input.value,
        pictures: latest.current.pictures,
        store: pictureStore,
        isCurrent,
      });
      return result.status === 'ready' ? { status: 'ready', prepared: result.value } : result;
    },
    [serverId],
  );
}

const styles = StyleSheet.create((theme) => ({
  panel: { paddingBottom: theme.space.s12 },
  footer: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.space.s8,
    marginTop: theme.space.s8,
    marginHorizontal: theme.space.s16,
    paddingTop: theme.space.s12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border.subtle,
  },
  footerGlyph: { paddingTop: theme.space.s2 },
  footerText: { flexShrink: 1, color: theme.colors.text.secondary },
  missing: { flexShrink: 1, gap: theme.space.s4 },
  missingTitle: { color: theme.colors.text.primary },
  missingAction: { alignItems: 'flex-start', paddingTop: theme.space.s4 },
}));
