import type { ComponentType, ReactNode } from 'react';
import { View } from 'react-native';

import type { HappierPortableStyle } from '../portableTypes.js';

export type HappierArtifactRevisionRow = Readonly<{
  bodyVersion: number;
  title: string;
  /** Already localized time and saved provenance from the revision's canonical owner. */
  subtitle: string;
  detail: string;
}>;

export type HappierArtifactRevisionListProps = Readonly<{
  sideBySide: boolean;
  title: string;
  currentTitle: string;
  currentSubtitle?: string;
  currentLabel: string;
  retentionLabel: string;
  revisions: readonly HappierArtifactRevisionRow[];
  selectedVersion: number | null;
  onSelectVersion: (bodyVersion: number) => void;
  colors: Readonly<{ secondary: string; tertiary: string }>;
  host: Readonly<{
    ItemGroup: ComponentType<Readonly<{ title: string; children?: ReactNode }>>;
    Item: ComponentType<Readonly<{ testID: string; title: string; subtitle?: string; detail?: string; selected?: boolean; onPress?: () => void; titleAccessory?: ReactNode; showChevron: boolean }>>;
    Text: ComponentType<Readonly<{ children: string; style: HappierPortableStyle }>>;
  }>;
}>;

/** List presentation only. Fetch, preview, revision authority and restore remain host-owned. */
export function HappierArtifactRevisionList(props: HappierArtifactRevisionListProps) {
  const { ItemGroup, Item, Text } = props.host;
  return <View testID="artifact-history:versions" style={props.sideBySide ? { width: 300 } : null}>
    <ItemGroup title={props.title}>
      <Item testID="artifact-history:current" title={props.currentTitle} subtitle={props.currentSubtitle}
        titleAccessory={<Text style={{ fontSize: 11, fontWeight: '600', color: props.colors.secondary }}>{props.currentLabel}</Text>}
        showChevron={false} />
      {props.revisions.map(revision => <Item key={revision.bodyVersion}
        testID={`artifact-history:version:${revision.bodyVersion}`} title={revision.title} subtitle={revision.subtitle}
        detail={revision.detail} selected={revision.bodyVersion === props.selectedVersion}
        onPress={() => props.onSelectVersion(revision.bodyVersion)} showChevron={!props.sideBySide} />)}
    </ItemGroup>
    <Text style={{ fontSize: 12, color: props.colors.tertiary, marginTop: 8, paddingHorizontal: 4 }}>{props.retentionLabel}</Text>
  </View>;
}
