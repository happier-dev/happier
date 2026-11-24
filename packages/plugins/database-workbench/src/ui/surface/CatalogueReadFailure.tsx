import { useMemo } from 'react';
import { Action, usePluginTranslation } from '@happier-dev/plugin-ui';
import { projectPluginActionRejectionV1 } from '@happier-dev/plugin-ui/hostApi';
import { WorkbenchOperationError } from '../workbench.js';

export function CatalogueReadFailure({ error, refresh }: Readonly<{ error: unknown; refresh: () => void }>) {
  const translate = usePluginTranslation();
  const execution = useMemo(() => projectPluginActionRejectionV1(
    error instanceof WorkbenchOperationError ? { code: error.failure.code, message: error.message } : error,
    translate,
  ), [error, translate]);
  return <Action.Failure execution={execution} onRetry={refresh} retryLabel={translate('plugins.database.retry', 'Try again')} />;
}
