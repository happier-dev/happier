import type { WidgetInstanceV1 } from '@happier-dev/protocol/widgets';
import { readUsageBreakdownsInstanceTitleV1 } from '@happier-dev/protocol/widgets/builtinWidgetDescriptorV1';
import { t } from '@/text';

export { USAGE_BREAKDOWN_DIMENSION_HEADING } from '@happier-dev/protocol/widgets/builtinWidgetDescriptorV1';

/** Localize the Protocol owner's configured title for existing frame and body consumers. */
export function readUsageBreakdownsInstanceTitle(instance: Pick<WidgetInstanceV1, 'definition' | 'bindings'>): string | null {
  const metadata = readUsageBreakdownsInstanceTitleV1(instance);
  return metadata ? t(metadata.titleKey) : null;
}
