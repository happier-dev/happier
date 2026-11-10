import type { ReactElement } from 'react';
import { UsageMeterRow as PresentationUsageMeterRow, type UsageMeterRowProps as PresentationUsageMeterRowProps } from '../presentation/data/UsageMeterRow.js';
import { usePluginTheme } from './PluginUiProvider.js';

export { UsageMeterStack, USAGE_METER_METRICS, type UsageMeterStackProps, type UsageMeterSize, type UsageMeterTone } from '../presentation/data/UsageMeterRow.js';
export type UsageMeterRowProps = Omit<PresentationUsageMeterRowProps, 'theme' | 'neutralFillColor' | 'trackColor' | 'placeholderColor'>;

/** Author theme adapter for the same usage row core consumes. */
export function UsageMeterRow(props: UsageMeterRowProps): ReactElement {
  return <PresentationUsageMeterRow {...props} theme={usePluginTheme()} />;
}
