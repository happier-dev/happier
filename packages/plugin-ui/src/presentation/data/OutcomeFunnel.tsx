import { RankedRows, type RankedRowsProps } from './RankedRows.js';

export type OutcomeFunnelStep = RankedRowsProps['rows'][number];
export type OutcomeFunnelProps = Omit<RankedRowsProps, 'rows'> & Readonly<{ steps: readonly OutcomeFunnelStep[] }>;

export function OutcomeFunnel(props: OutcomeFunnelProps) {
  const { steps, ...rowsProps } = props;
  return <RankedRows {...rowsProps} rows={steps} />;
}
