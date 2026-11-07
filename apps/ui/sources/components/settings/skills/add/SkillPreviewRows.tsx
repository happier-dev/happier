import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { SkillInstallPreviewV1 } from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { skillSource, skillSourceVerification } from '../skillsCollectionModel';
import type { CapabilityFactsProps } from '@/components/capabilities/facts/CapabilityFacts';

/** The preview's identity facts: where it was found, pinned. */
export function previewRef(item: SkillInstallPreviewV1): string | undefined {
  const provenance = item.provenance;
  if (provenance.kind === 'link' && provenance.ref.kind === 'gitTree')
    return provenance.ref.commit.slice(0, 7);
  if (
    provenance.kind === 'registry' &&
    provenance.registry.ref.kind === 'gitTree'
  )
    return provenance.registry.ref.commit.slice(0, 7);
  return undefined;
}

/** Index items name their host; Git previews retain their source folder and commit. */
export function previewSource(item: SkillInstallPreviewV1): CapabilityFactsProps['source'] {
  return item.provenance.kind === 'wellKnown'
    ? skillSource(item, (id) => id)
    : { kind: 'git', label: item.path || '/', ...(previewRef(item) ? { ref: previewRef(item) } : {}) };
}

/** Only a verified publisher digest earns the verified fact; local bundle pins do not. */
export function previewSourceFacts(item: SkillInstallPreviewV1): CapabilityFactsProps['extra'] {
  const verification = skillSourceVerification(item);
  return verification ? [verification] : undefined;
}

/** "In your library": the one mark for a skill the library already holds (a Browse row, a held preview row). */
export function SkillInLibraryMark(props: Readonly<{ testID?: string }>) {
  const { theme } = useUnistyles();
  return (
    <View style={styles.inLibrary} testID={props.testID}>
      <Icon name="check" size={ICON_SIZE.xs} color={theme.colors.text.secondary} />
      <Text variant="meta" style={{ color: theme.colors.text.secondary }}>
        {t('capabilities.skillAdd.inLibrary')}
      </Text>
    </View>
  );
}

/** The preview says the library holds a different skill with this name: Add makes a separate copy, never an overwrite. */
export function SkillSameNameNote(props: Readonly<{ name: string; testID?: string }>) {
  const { theme } = useUnistyles();
  return (
    <View style={styles.sameName} testID={props.testID}>
      <Icon name="info" size={ICON_SIZE.xs} color={theme.colors.text.secondary} />
      <Text variant="meta" style={{ flexShrink: 1, color: theme.colors.text.secondary }}>
        {t('capabilities.skillAdd.sameName', { name: props.name })}
      </Text>
    </View>
  );
}

/**
 * What a previewed skill the library already holds shows in place of a tick: the In your library mark and Open on
 * the id the Action returned (`inLibrary`). Spread into a `CapabilityRow`; nothing here decides what is held.
 */
export function heldSkillRowProps(
  held: string,
  onOpen: (skillId: string) => void,
  testID: string,
): Readonly<{ whereSummary: React.ReactElement; action: React.ReactElement }> {
  return {
    whereSummary: <SkillInLibraryMark testID={`${testID}.inLibrary`} />,
    action: (
      <RoundButton
        size="small"
        display="secondary"
        title={t('capabilities.skillAdd.open')}
        onPress={() => onOpen(held)}
        testID={`${testID}.open`}
      />
    ),
  };
}

const styles = StyleSheet.create((theme) => ({
  sameName: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s4,
  },
  inLibrary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s4,
  },
}));
