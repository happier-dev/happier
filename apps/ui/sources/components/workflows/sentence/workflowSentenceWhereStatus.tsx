import * as React from 'react';
import type { StyleProp, TextStyle } from 'react-native';

import { Text } from '@/components/ui/text/Text';

/**
 * The sentence's "on ⟨Machine⟩ in ⟨folder⟩" line holds the When clause's reason about the Machine that watches for its
 * event ("That Machine isn't answering…"), so the reason reads after the Machine it names. The When clause still
 * decides the reason; the sentence only decides where it stands. Outside a sentence it stays under its clause.
 */
type WhereStatusSlot = Readonly<{
  read: () => React.ReactNode;
  subscribe: (listener: () => void) => () => void;
  publish: (owner: object, node: React.ReactNode) => void;
  retract: (owner: object) => void;
}>;

function createWhereStatusSlot(): WhereStatusSlot {
  let current: Readonly<{ owner: object; node: React.ReactNode }> | null = null;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  return {
    read: () => current?.node ?? null,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    publish: (owner, node) => {
      current = { owner, node };
      notify();
    },
    retract: (owner) => {
      if (current?.owner !== owner) return;
      current = null;
      notify();
    },
  };
}

const WhereStatusContext = React.createContext<WhereStatusSlot | null>(null);

/** The sentence provides the slot around its clauses and draws it with `WorkflowSentenceWhereStatus`. */
export function useWorkflowSentenceWhereStatusSlot(): WhereStatusSlot {
  return React.useState(createWhereStatusSlot)[0];
}

export const WorkflowSentenceWhereStatusProvider = WhereStatusContext.Provider;

/** Under the "on ⟨Machine⟩" line: the reason the When clause published, if any. */
export function WorkflowSentenceWhereStatus(
  props: Readonly<{ slot: WhereStatusSlot }>,
): React.ReactElement | null {
  const node = React.useSyncExternalStore(
    props.slot.subscribe,
    props.slot.read,
    props.slot.read,
  );
  return node === null ? null : <>{node}</>;
}

/** The When clause's Machine reason: under the "on" line inside a sentence, under the clause elsewhere. */
export function WorkflowSentenceWhereStatusLine(
  props: Readonly<{
    testID: string;
    style: StyleProp<TextStyle>;
    children: string;
  }>,
): React.ReactElement | null {
  const slot = React.useContext(WhereStatusContext);
  const { testID, style, children } = props;
  React.useLayoutEffect(() => {
    if (slot === null) return undefined;
    const owner = {};
    slot.publish(
      owner,
      <Text testID={testID} style={style}>
        {children}
      </Text>,
    );
    return () => slot.retract(owner);
  }, [slot, testID, style, children]);
  return slot === null ? (
    <Text testID={testID} style={style}>
      {children}
    </Text>
  ) : null;
}
