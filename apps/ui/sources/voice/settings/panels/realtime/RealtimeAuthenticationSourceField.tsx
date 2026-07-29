import * as React from 'react';

import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { tLoose } from '@/text';

import type { RealtimeSettingsFieldDescriptor } from './descriptor';

type AuthenticationValue = Readonly<{
  source?: unknown;
}>;

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function translate(key: unknown, fallback = ''): string {
  return typeof key === 'string' && key.length > 0 ? tLoose(key) : fallback;
}

export function RealtimeAuthenticationSourceField(props: Readonly<{
  field: RealtimeSettingsFieldDescriptor;
  value: unknown;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (value: unknown) => void;
  popoverBoundaryRef?: React.RefObject<any> | null;
}>) {
  const current = (record(props.value) ?? {}) as AuthenticationValue;
  const selectedSource = typeof current.source === 'string' ? current.source : 'voice_saved_secret';
  const options = Array.isArray(props.field.options)
    ? props.field.options.flatMap((raw) => {
      const option = record(raw);
      return option && typeof option.id === 'string' ? [option] : [];
    })
    : [];
  const rows: DropdownMenuItem[] = options.map((option) => ({
    id: String(option.id),
    title: translate(option.titleKey, String(option.id)),
    subtitle: translate(option.subtitleKey),
  }));
  const selectedOption = options.find((option) => option.id === selectedSource) ?? options[0] ?? null;

  return (
    <DropdownMenu
      testID={`voice-realtime-field-${props.field.path.replaceAll('.', '-')}`}
      open={props.open}
      onOpenChange={props.onOpenChange}
      variant="selectable"
      search={false}
      selectedId={selectedSource}
      showCategoryTitles={false}
      matchTriggerWidth
      connectToTrigger
      rowKind="item"
      popoverBoundaryRef={props.popoverBoundaryRef}
      itemTrigger={{
        title: translate(props.field.titleKey),
        subtitle: translate(props.field.subtitleKey),
        showSelectedSubtitle: false,
        detailFormatter: () => translate(selectedOption?.titleKey, selectedSource),
      }}
      items={rows}
      onSelect={(id) => {
        props.onOpenChange(false);
        if (!options.some((option) => option.id === id)) return;
        props.onChange({ source: id });
      }}
    />
  );
}
