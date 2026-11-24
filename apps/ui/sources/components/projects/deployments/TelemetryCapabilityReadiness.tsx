import * as React from 'react';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';

import { formatTelemetryCapabilityStatus } from './telemetryCapabilityStatus';

type Samples = Readonly<{ metrics: number | null; appLlmCost: number | null; exceptions: number | null }>;

/**
 * "Getting ready" (lab p7Setup-waiting): each recorded choice that has kept nothing yet says so, from the collector
 * status owner, and Exceptions offers the app change browser errors need (the existing Add telemetry Session handoff).
 * A receiving choice leaves the section (its own view's bar says when it last arrived); with none waiting it is gone.
 */
export function TelemetryCapabilityReadiness(props: Readonly<{
  lastReceivedAt: number | null;
  samples: Samples;
  recorded: Readonly<{ metrics: boolean; appLlmCost: boolean; exceptions: boolean }>;
  onAddTelemetry: (() => void) | null;
  addingTelemetry: boolean;
}>) {
  const { lastReceivedAt, samples, recorded } = props;
  const rows = [
    { id: 'requests', title: t('deploymentTelemetry.sheet.requests'), description: t('deploymentTelemetry.sheet.requestsDescription'),
      at: lastReceivedAt },
    ...(recorded.exceptions ? [{ id: 'exceptions', title: t('deploymentTelemetry.sheet.exceptions'),
      description: t('deploymentTelemetry.sheet.exceptionsDescription'), at: samples.exceptions }] : []),
    ...(recorded.appLlmCost ? [{ id: 'llm', title: t('deploymentTelemetry.sheet.llm'),
      description: t('deploymentTelemetry.sheet.llmDescription'), at: samples.appLlmCost }] : []),
    ...(recorded.metrics ? [{ id: 'metrics', title: t('deploymentTelemetry.sheet.metrics'),
      description: t('deploymentTelemetry.sheet.metricsDescription'), at: samples.metrics }] : []),
  ];
  // Only the choices still waiting: a receiving one says so on its own view, and healthy is quiet.
  const waiting = rows.filter(row => row.at === null);
  if (waiting.length === 0) return null;
  return (
    <ItemGroup testID="project-deployments.telemetry.readiness" title={t('deploymentTelemetry.readiness.title')}
      description={t('deploymentTelemetry.readiness.description')}>
      {waiting.map(row => (
        <Item
          key={row.id}
          testID={`project-deployments.telemetry.readiness.${row.id}`}
          title={row.title}
          subtitle={row.id === 'exceptions' && row.at === null && props.onAddTelemetry
            ? `${formatTelemetryCapabilityStatus(row.at)} · ${row.description}` : row.description}
          detail={row.id === 'exceptions' && row.at === null && props.onAddTelemetry ? undefined : formatTelemetryCapabilityStatus(row.at)}
          mode="info"
          showChevron={false}
          rightElementOutsidePressable
          rightElement={row.id === 'exceptions' && row.at === null && props.onAddTelemetry ? (
            <RoundButton testID="project-deployments.telemetry.exceptions.add-telemetry" size="small" display="secondary"
              title={t('deploymentTelemetry.menu.addTelemetry')} onPress={props.onAddTelemetry}
              disabled={props.addingTelemetry} loading={props.addingTelemetry} />
          ) : undefined}
        />
      ))}
    </ItemGroup>
  );
}
