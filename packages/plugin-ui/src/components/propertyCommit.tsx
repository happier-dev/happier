import { useRef, useState } from 'react';
import { isPluginActionConfirmationDeclined, projectPluginActionRejectionV1 } from '../hostApi/executeAction.js';
import { usePluginTranslation } from './PluginUiProvider.js';
import { ErrorState } from './State.js';

/** Property callbacks may return an Action settlement, or void for a local edit. Never replay either. */
export function usePropertyCommit() {
  const translate = usePluginTranslation();
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [issue, setIssue] = useState<Readonly<{ unknown: boolean; code?: string }> | null>(null);
  const commit = async (apply: () => unknown): Promise<boolean> => {
    if (pending.current) return false;
    pending.current = true;
    setBusy(true);
    try {
      const result = await apply();
      if (result !== null && typeof result === 'object') {
        const status: unknown = Reflect.get(result, 'status');
        if (status === 'refused' || status === 'failed' || status === 'uncertain') {
          const reason: unknown = Reflect.get(result, 'reason');
          setIssue({ unknown: status === 'uncertain', ...(typeof reason === 'string' ? { code: reason } : {}) });
          return false;
        }
      }
      setIssue(null);
      return true;
    } catch (error) {
      const rejection = projectPluginActionRejectionV1(error, translate);
      const code = rejection.status === 'error' || rejection.status === 'outcomeUnknown' ? rejection.code : undefined;
      setIssue({ unknown: !isPluginActionConfirmationDeclined(rejection) && code !== 'denied' && code !== 'cancelled',
        ...(code === undefined ? {} : { code }) });
      return false;
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const notice = issue === null ? null : <ErrorState layout="line"
    title={issue.unknown
      ? translate('happier.plugin-ui.propertyList.notConfirmed', 'Change not confirmed')
      : translate('happier.plugin-ui.propertyList.notApplied', 'Change not applied')}
    description={translate('happier.plugin-ui.propertyList.refreshBeforeRetry', 'Refresh this page to check the current value before trying again.')}
    {...(issue.code === undefined ? {} : { details: issue.code })} />;
  return { commit, busy, notice };
}
