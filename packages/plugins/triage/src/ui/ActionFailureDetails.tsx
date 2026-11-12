import * as React from 'react';
import { readPluginActionFailureAuthorPayload } from '@happier-dev/protocol/plugins/actions/invocation';
import { presentActionFailure, type PluginUiActionFailurePresentationV1 } from '@happier-dev/plugin-sdk/ui';
import { Stack, Text, TechnicalDetailsDisclosure, usePluginHostApi, usePluginTranslation } from '@happier-dev/plugin-ui';
import type { ProtocolJsonValue } from '@happier-dev/plugin-sdk/protocol';

/** One presentation and technical-reference owner for Triage read and write failures. */
export function ActionFailureDetails({ code, message, details, requestId, detail, phase, effectAttempted, showReason = true, title }: Readonly<{
  code?: string; message?: string; details?: ProtocolJsonValue; requestId?: string; detail?: string; phase?: string; effectAttempted?: boolean; showReason?: boolean; title?: string;
}>) {
  const host = usePluginHostApi();
  const text = usePluginTranslation();
  const [presented, setPresented] = React.useState<Readonly<{
    code: string; message?: string; details?: ProtocolJsonValue; requestId?: string;
    value: PluginUiActionFailurePresentationV1;
  }> | null>(null);
  React.useEffect(() => {
    if (code === undefined) return;
    let active = true;
    const authored = readPluginActionFailureAuthorPayload(details);
    void presentActionFailure(host, { ok: false, errorCode: code,
      ...(message === undefined ? {} : { error: message, message }),
      ...(authored.remediation === undefined ? {} : { remediation: authored.remediation }),
      ...(authored.failureCause === undefined ? {} : { failureCause: authored.failureCause }),
      ...(authored.details === undefined ? {} : { details: authored.details }),
      ...(requestId === undefined ? {} : { requestId }),
    }).then(value => { if (active) setPresented({ code, message, details, requestId, value }); }, () => {
      // Presentation failure keeps the producer's message and correlation visible below.
    });
    return () => { active = false; };
  }, [host, code, message, details, requestId]);
  const presentation = presented != null && presented.code === code && presented.message === message
    && presented.details === details && presented.requestId === requestId ? presented.value : null;
  const lines = [
    ...(code === undefined ? [] : [{ key: 'code', label: text('plugins.triage.sourceFailure.code', 'Code'), value: code }]),
    ...(requestId === undefined ? [] : [{ key: 'requestId', label: text('plugins.triage.sourceFailure.requestId', 'Request ID'), value: requestId }]),
    ...(phase === undefined ? [] : [{ key: 'phase', label: text('plugins.triage.sourceFailure.phase', 'Phase'), value: phase }]),
    ...(effectAttempted === undefined ? [] : [{ key: 'effectAttempted', label: text('plugins.triage.sourceFailure.effectAttempted', 'Effect attempted'), value: String(effectAttempted) }]),
    ...(detail === undefined ? [] : [{ key: 'detail', label: text('plugins.triage.sourceFailure.reason', 'Reason'), value: detail }]),
  ];
  for (const line of presentation?.technicalDetails ?? []) {
    if (!lines.some(existing => existing.key === line.key)) lines.push(line);
  }
  return <Stack gap="small">
    {!showReason || (message === undefined && presentation === null) ? null : <Text>{presentation?.reason ?? message}</Text>}
    {presentation?.nextStep == null ? null : <Text>{presentation.nextStep}</Text>}
    <TechnicalDetailsDisclosure title={title ?? text('plugins.triage.surface.detail.tab.details', 'Details')} lines={lines} />
  </Stack>;
}
