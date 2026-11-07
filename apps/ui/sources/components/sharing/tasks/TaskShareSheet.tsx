import * as React from 'react';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { ShareSheet } from '../ShareSheet';
import type {
  ShareSheetActions,
  ShareSheetModel,
  ShareSheetPresentation,
} from '../shareSheetTypes';
import { createTaskShareAdapter } from './taskShareAdapter';
import {
  presentTaskShareFailure,
  useTaskShareController,
} from './useTaskShareController';

export type TaskShareSheetProps = Readonly<{
  taskId: string;
  ownerAccountId: string;
  scope?: ServerAccountScope;
  presentation?: ShareSheetPresentation;
  onRequestClose?: () => void;
  testID?: string;
}>;

const DEFAULT_TEST_ID = 'task-share-editor';

function ScopedTaskShareSheet(
  props: TaskShareSheetProps & Readonly<{ scope: ServerAccountScope }>,
): React.ReactElement {
  const controller = useTaskShareController({
    taskId: props.taskId,
    ownerAccountId: props.ownerAccountId,
    scope: props.scope,
  });
  const adapter = createTaskShareAdapter({
    disclosure: controller.disclosure,
    encrypted: controller.encrypted,
    readiness: controller.readiness,
    ...(controller.sendKeys ? { sendKeys: controller.sendKeys } : {}),
    sendingKeys: controller.sendingKeys,
    loading: controller.loading,
    ...(controller.issue ? { issue: controller.issue } : {}),
    ...(controller.notice ? { notice: controller.notice } : {}),
    readOnly:
      !controller.loading && !controller.issue && !controller.model.editable,
    retryContent: controller.retryContent,
  });
  return (
    <ShareSheet
      model={controller.model}
      actions={controller.actions}
      adapter={adapter}
      presentation={props.presentation ?? 'full'}
      onRequestClose={props.onRequestClose}
      testID={props.testID ?? DEFAULT_TEST_ID}
    />
  );
}

const noop = () => {};
const UNSCOPED_ACTIONS: ShareSheetActions = {
  setQuery: noop,
  retryDirectory: noop,
  loadMore: noop,
  addPrincipal: noop,
  retryMutation: noop,
  setAccessLevel: noop,
  requestRemove: noop,
  confirmRemove: noop,
  cancelRemove: noop,
  explain: noop,
};
const UNSCOPED_MODEL: ShareSheetModel = {
  revision: 0,
  editable: false,
  stale: false,
  owner: null,
  grants: [],
  directory: { query: '', sections: [] },
};

/** Share one personal or shared Happier task: the one share sheet with the task adapter over the task grant Actions. */
export function TaskShareSheet(props: TaskShareSheetProps): React.ReactElement {
  const activeScope = useActiveServerAccountScope();
  const scope = props.scope ?? activeScope;
  if (scope)
    return (
      <ScopedTaskShareSheet
        key={`${scope.serverId}:${scope.accountId}:${props.ownerAccountId}:${props.taskId}`}
        {...props}
        scope={scope}
      />
    );
  const adapter = createTaskShareAdapter({
    disclosure: null,
    encrypted: false,
    readiness: new Map(),
    loading: false,
    readOnly: false,
    retryContent: noop,
    issue: presentTaskShareFailure('not_authenticated'),
  });
  return (
    <ShareSheet
      model={UNSCOPED_MODEL}
      actions={UNSCOPED_ACTIONS}
      adapter={adapter}
      presentation={props.presentation ?? 'full'}
      onRequestClose={props.onRequestClose}
      testID={props.testID ?? DEFAULT_TEST_ID}
    />
  );
}

