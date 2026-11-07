import { useState, type ReactElement } from 'react';

import { CountedDisclosureFrame } from './CountedDisclosureItem.js';
import { HappierDisclosureCaret } from './DisclosureCaret.js';
import { TextField } from './Form.js';
import { Item } from './List.js';

type EndpointHeaderMap = Readonly<Record<string, string>>;

/** Where the editor's values are written: an unsaved draft, every machine (Account) or the selected machine. */
export type EndpointHeadersLayer = 'draft' | 'account' | 'machine';

/** The editor's words, already localized by the caller. */
export type EndpointHeadersEditorCopy = Readonly<{
  /** The folded row's title, such as "Request headers" or "Headers on this machine". */
  title: string;
  /** Where an untouched value comes from, such as "From the provider" or "Same as every machine". */
  inherited: string;
  /** A value this layer sets itself, such as "Changed" or "Set for every machine". */
  set: string;
  /** A required header nothing supplies yet. */
  required: string;
  /** The count of this layer's own entries, such as "2 changed". */
  changedCount: (count: number) => string;
  /** The required headers still empty, joined by the editor, such as "Needs cf-aig-gateway-id". */
  needs: (names: string) => string;
  /** The reset row's title and what it returns to. */
  reset: string;
  resetDescription: string;
}>;

export type EndpointHeadersEditorProps = Readonly<{
  testID: string;
  layer: EndpointHeadersLayer;
  /** This layer's own entries; null when the layer sets none. */
  values: EndpointHeaderMap | null;
  /** What applies when this layer sets nothing: the provider's defaults, or every machine's. */
  inherited: EndpointHeaderMap;
  /** Header names the endpoint needs a value for. */
  required?: readonly string[];
  /** The provider's consequence per header, already localized. */
  hints?: Readonly<Record<string, string>>;
  copy: EndpointHeadersEditorCopy;
  disabled?: boolean;
  /** The layer's next entries, or null to remove them all (the layer then inherits every value). */
  onChange: (next: Record<string, string> | null) => void;
  /** The hairline under the folded row; an enclosing group injects it. */
  showDivider?: boolean;
}>;

/** The header names one layer shows: the required ones, then what it inherits, then its own. */
export function readEndpointHeaderNames(input: Readonly<{
  required?: readonly string[];
  inherited: EndpointHeaderMap;
  layer: EndpointHeaderMap | null;
}>): string[] {
  return [...new Set([...(input.required ?? []), ...Object.keys(input.inherited), ...Object.keys(input.layer ?? {})])];
}

/**
 * One endpoint's public request headers (logging, billing, cache and routing policy) as typed rows at one
 * layer. Each row shows the value in force, where it comes from and the provider's consequence; typing the
 * inherited value back (or clearing it) drops that entry from the layer, and Reset removes the whole layer.
 * Values are never secrets: credentials belong in Saved Secrets, not in these maps.
 */
export function EndpointHeadersEditor(props: EndpointHeadersEditorProps): ReactElement | null {
  const { values, inherited, required, copy } = props;
  const names = readEndpointHeaderNames({ required, inherited, layer: values });
  const missing = names.filter((name) => (values?.[name] ?? inherited[name] ?? '') === '');
  const changedCount = Object.keys(values ?? {}).length;
  const [expanded, setExpanded] = useState(() => changedCount > 0 || missing.length > 0);
  if (names.length === 0) return null;
  const summary = missing.length > 0
    ? copy.needs(missing.join(', '))
    : changedCount > 0
      // A draft has only its own changes; a saved layer says which layer holds them.
      ? props.layer === 'draft' ? copy.changedCount(changedCount) : `${copy.set} · ${copy.changedCount(changedCount)}`
      : copy.inherited;
  const commit = (name: string, draft: string): string => {
    const value = draft.trim();
    const next: Record<string, string> = { ...values };
    if (value === '' || value === inherited[name]) delete next[name];
    else next[name] = value;
    if ((values?.[name] ?? null) !== (next[name] ?? null)) props.onChange(Object.keys(next).length > 0 ? next : null);
    return next[name] ?? inherited[name] ?? '';
  };
  return (
    <CountedDisclosureFrame
      testID={`${props.testID}.headers`}
      expanded={expanded}
      onExpandedChange={setExpanded}
      showDivider={props.showDivider}
      header={(state) => (
        <Item
          testID={`${props.testID}.headers.header`}
          title={copy.title}
          subtitle={summary}
          onPress={state.headerProps.onPress}
          accessibilityRole={state.headerProps.accessibilityRole}
          accessibilityExpanded={state.expanded}
          accessory={<HappierDisclosureCaret expanded={state.expanded} />}
        />
      )}
    >
      {names.map((name) => {
        const own = values?.[name];
        const source = own !== undefined ? copy.set : inherited[name] !== undefined ? copy.inherited : copy.required;
        const hint = props.hints?.[name];
        return (
          <Item
            key={name}
            testID={`${props.testID}.header.${name}.row`}
            title={name}
            subtitle={hint ? `${source} · ${hint}` : source}
            accessoryWraps
            accessoryOutsidePressable
            accessory={(
              <TextField
                testID={`${props.testID}.header.${name}`}
                presentation="field"
                label={name}
                value={own ?? inherited[name] ?? ''}
                onChange={() => undefined}
                onCommit={(draft) => commit(name, draft)}
                allowEmpty
                monospace
                autoCapitalize="none"
                autoCorrect={false}
                disabled={props.disabled}
              />
            )}
          />
        );
      })}
      {changedCount > 0 ? (
        <Item
          testID={`${props.testID}.headers.reset`}
          title={copy.reset}
          subtitle={copy.resetDescription}
          disabled={props.disabled}
          onPress={() => props.onChange(null)}
        />
      ) : null}
    </CountedDisclosureFrame>
  );
}
