import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import {
  PUBLIC_PROFILE_FIELDS_V1,
  type PublicProfileField,
} from '@happier-dev/protocol/account/publicProfile';
import type { PublicProfilePreparationUnavailableReasonV1 } from '@happier-dev/protocol/account/publicProfileIntents';
import type { PublicProfileLocalPreviewViewV1, PublicProfileViewV1 } from '@happier-dev/protocol/account/publicProfilePublication';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { CodeBlockView } from '@/components/ui/code/blocks/CodeBlockView';
import {
  ExpandableItem,
} from '@/components/ui/lists/ExpandableItem';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { Text } from '@/components/ui/text/Text';
import type { CustomModalInjectedProps } from '@/modal';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import { t } from '@/text';

export type PublicProfileReviewProps = Readonly<{
  kind: 'publish' | 'apply';
  /** Where the page lives, from the service's canonical public URL. */
  pageUrl: string | null;
  /** The captured window the published numbers cover. */
  period: string;
  sharedFields: readonly PublicProfileField[];
  /** Exactly what visitors would read, as captured for this review. */
  disclosure: PublicProfileLocalPreviewViewV1 | PublicProfileViewV1 | null;
  preparationReason?: PublicProfilePreparationUnavailableReasonV1 | null;
  /** The retained picture copy Confirm sends; absent when no picture leaves the device. */
  renderPicture?: () => React.ReactNode;
  endToEndEncrypted: boolean;
  indexable: boolean;
  confirming: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  /** The hosting card: the review scrolls inside it while Cancel and Publish stay in its footer. */
  setChrome?: CustomModalInjectedProps['setChrome'];
}>;

/**
 * The one review before anything leaves the device (lab `ppflow-F2d`): where it lives and what period
 * it covers, which items become public and which stay hidden, what stays readable by the service, the
 * exact picture copy that is uploaded, and the exact data visitors can read.
 */
export function PublicProfileReview(
  props: PublicProfileReviewProps,
): React.ReactElement {
  const [showData, setShowData] = React.useState(false);
  const shared = new Set(props.sharedFields);
  const hidden = PUBLIC_PROFILE_FIELDS_V1.filter((field) => !shared.has(field));
  const names = (fields: readonly PublicProfileField[]) =>
    fields
      .map((field) => t(`publicIdentity.publicData.fields.${field}`))
      .join(' · ');
  // Q13: weekly shares are percentages, but with the Tokens total public they reveal weekly amounts.
  const jointInference = shared.has('tokens') && shared.has('weeklyAgentMix');
  const preparationNotice = props.preparationReason ? t(`publicIdentity.profile.reasons.${props.preparationReason}`) : null;
  const consequences = [
    jointInference
      ? t('publicIdentity.publicData.details.weeklyAgentMix')
      : null,
    // What is never part of it, in the page's own words (lab F2d "Never part of it").
    t('publicIdentity.page.footerNote'),
    props.endToEndEncrypted ? t('publicIdentity.review.plaintext') : null,
    props.kind === 'publish' ? t('publicIdentity.review.daily') : null,
    props.indexable ? null : t('publicIdentity.review.noindex'),
  ].filter((line): line is string => line !== null);
  const json = React.useMemo(
    () => {
      if (!showData) return '';
      if (preparationNotice) return preparationNotice;
      const disclosure = props.disclosure;
      const atmosphere = disclosure?.appearance.atmosphere;
      if (disclosure && atmosphere?.source === 'picture' && 'content' in atmosphere.picture) {
        // Pixels are inspected above; the storage-generated public ref does not exist until commit.
        const { content: _content, ...picture } = atmosphere.picture;
        return JSON.stringify({ ...disclosure, appearance: { ...disclosure.appearance,
          atmosphere: { ...atmosphere, picture } } }, null, 2);
      }
      return JSON.stringify(disclosure, null, 2);
    },
    [showData, preparationNotice, props.disclosure],
  );
  const { confirming, kind, onCancel, onConfirm } = props;
  const actions = React.useMemo(() => (
    <View style={styles.actions}>
      <RoundButton
        testID="public-profile-review-cancel"
        size="normal"
        display="secondary"
        title={t('publicIdentity.review.cancel')}
        disabled={confirming}
        onPress={onCancel}
      />
      <RoundButton
        testID="public-profile-review-confirm"
        size="normal"
        title={
          kind === 'publish'
            ? t('publicIdentity.review.confirmPublish')
            : t('publicIdentity.review.confirmApply')
        }
        loading={confirming}
        disabled={confirming}
        onPress={onConfirm}
      />
    </View>
  ), [confirming, kind, onCancel, onConfirm]);
  // However short the window, the disclosures scroll between the title band and the pinned actions.
  useModalCardChrome(props.setChrome, React.useMemo(() => (
    { kind: 'card' as const, scrollHost: 'bounded' as const, bodyScroll: 'auto' as const, footer: actions }
  ), [actions]));
  return (
    // A card body owns its padding: its lists keep the paragraphs' edge instead of adding a page inset.
    <ListPresentationProvider value="page" pageInsets="contained">
    <View style={styles.body} testID="public-profile-review">
      {props.pageUrl ? (
        <Text variant="body" style={styles.secondary}>
          {t('publicIdentity.review.where', {
            url: props.pageUrl,
            period: props.period,
          })}
        </Text>
      ) : null}
      {/* What becomes public and what stays hidden, one row each (lab F2d). The card body owns the spacing. */}
      <ItemGroup header="none">
        <Item
          testID="public-profile-review-items"
          title={t('publicIdentity.review.public')}
          subtitle={props.sharedFields.length > 0 ? names(props.sharedFields) : t('publicIdentity.review.none')}
          subtitleLines={0}
          showChevron={false}
        />
        {hidden.length > 0 ? (
          <Item
            testID="public-profile-review-hidden"
            title={t('publicIdentity.review.hidden')}
            subtitle={names(hidden)}
            subtitleLines={0}
            showChevron={false}
          />
        ) : null}
      </ItemGroup>
      {props.renderPicture ? (
        <View style={styles.section} testID="public-profile-review-picture">
          <View style={styles.picture}>{props.renderPicture()}</View>
          <Text variant="meta" style={styles.secondary}>
            {t('publicIdentity.review.picture')}
          </Text>
        </View>
      ) : null}
      {/* One note of consequences, not four more sections. */}
      <View style={styles.notes}>
        {consequences.map((line) => (
          <Text key={line} variant="meta" style={styles.secondary}>
            {line}
          </Text>
        ))}
      </View>
      {/* A row like the ones above, on the same inner edge, instead of a bare row inset from the paragraphs. */}
      <ItemGroup header="none">
      <ExpandableItem
        expanded={showData}
        onExpandedChange={setShowData}
        showDivider={false}
        header={(state) => (
          <Item
            {...state.headerProps}
            testID="public-profile-review-data"
            title={t('publicIdentity.review.viewData')}
            subtitle={preparationNotice ?? t('publicIdentity.review.viewDataDetail')}
          />
        )}
      >
        {showData ? (
          <CodeBlockView
            code={json}
            language="json"
            selectable
            showCopyButton
          />
        ) : null}
      </ExpandableItem>
      </ItemGroup>
      {/* Without card chrome (an embedding host), the actions end the body. */}
      {props.setChrome ? null : actions}
    </View>
    </ListPresentationProvider>
  );
}

const styles = StyleSheet.create((theme) => ({
  // The card chrome insets only its title band and footer; the review stands on that same edge.
  body: { gap: theme.space.s12, paddingHorizontal: theme.space.s16, paddingBottom: theme.space.s16 },
  section: { gap: theme.space.s4 },
  notes: { gap: theme.space.s8 },
  primary: { color: theme.colors.text.primary },
  secondary: { color: theme.colors.text.secondary },
  picture: {
    overflow: 'hidden',
    borderRadius: theme.borderRadius.lg,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: theme.space.s8,
  },
}));
