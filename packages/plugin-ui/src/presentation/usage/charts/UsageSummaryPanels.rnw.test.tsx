import { describe, expect, it } from 'vitest';

import { mountThroughReactNativeWeb } from '../../../rnwMount.testSupport.js';
import { SURFACE_CONTEXT_THEME_FIXTURE as theme } from '../../../../../plugin-sdk/src/ui/surfaceContext.fixture.js';
import { UsageFootprintBody, UsagePeriodSummaryBody, UsageSourceCoverageBody } from './UsageSummaryPanels.js';
import { ChartInteractionProvider } from '../../data/ChartDatum.js';

describe('shared Usage summary panels', () => {
  it('keeps footprint retry and method outside its admitted token target, and removes the datum with the tokens', async () => {
    const labels = { title: 'Insufficient basis', reason: 'No applicable method', noEstimate: 'No estimate',
      accounted: 'Accounted', tokensUnit: 'tokens', proxy: 'Proxy', proxyDetail: 'Not measured energy',
      methodTitle: 'Method', methodBody: 'Requires serving evidence' };
    const render = (accountedTokens?: string) => <ChartInteractionProvider renderDatum={(datum, visual, testID) =>
      <button data-testid={testID} title={datum.value}>{visual}</button>}>
      <UsageFootprintBody theme={theme} labels={labels} testID="footprint" accountedTokens={accountedTokens}
        accountedTokensDatum={{ label: 'Accounted', value: '4,186,010 tokens' }}
        coverage={<button data-testid="retry">Retry</button>} />
    </ChartInteractionProvider>;
    const mount = mountThroughReactNativeWeb(render('4.2M'));
    try {
      const datum = mount.container.querySelector('[data-testid="footprint.tokens.detail"]');
      expect(datum?.getAttribute('title')).toBe('4,186,010 tokens');
      expect(datum?.textContent).toContain('4.2M');
      expect(datum?.textContent).not.toContain('Requires serving evidence');
      expect(datum?.querySelector('button')).toBeNull();
      expect(mount.container.querySelector('[data-testid="retry"]')).toBeTruthy();
      await mount.render(render());
      expect(mount.container.querySelector('[data-testid="footprint.tokens.detail"]')).toBeNull();
      expect(mount.container.textContent).not.toContain('4,186,010');
      expect(mount.container.textContent).toContain('Requires serving evidence');
    } finally { mount.unmount(); }
  });

  it('uses the admitted duration datum without reinterpreting the numeric hours or wrapping its accessory', () => {
    const mount = mountThroughReactNativeWeb(<ChartInteractionProvider renderDatum={(datum, visual, testID) =>
      <span data-testid={testID} title={datum.value}>{visual}</span>}>
      <UsagePeriodSummaryBody theme={theme} testID="summary" stats={[{ id: 'agent', label: 'Agent time', value: 1.125,
        valueFormatter: () => '1h 7m', datum: { label: 'Agent time', value: '4,050 seconds' },
        accessory: <button data-testid="consent">Show</button> }]} />
    </ChartInteractionProvider>);
    try {
      const datum = mount.container.querySelector('[data-testid="summary.agent.detail"]');
      expect(datum?.getAttribute('title')).toBe('4,050 seconds');
      expect(datum?.textContent).toContain('1h 7m');
      expect(datum?.querySelector('button')).toBeNull();
      expect(mount.container.querySelector('[data-testid="consent"]')).toBeTruthy();
    } finally { mount.unmount(); }
  });
  it('renders independent summary facts without requiring a token hero or a private query', () => {
    const mount = mountThroughReactNativeWeb(<UsagePeriodSummaryBody theme={theme} stats={[
      { id: 'active', label: 'Active days', value: 6 },
      { id: 'streak', label: 'Current streak', value: 3 },
      { id: 'merged', label: 'Merged work', value: 0 },
    ]} />);
    try {
      expect(mount.container.textContent).toContain('Active days6');
      expect(mount.container.textContent).toContain('Current streak3');
      expect(mount.container.textContent).toContain('Merged work0');
      expect(mount.container.textContent).not.toContain('Tokens');
    } finally { mount.unmount(); }
  });

  it('removes accounted tokens when disclosure narrows while keeping the footprint method visible', async () => {
    const labels = {
      title: 'Insufficient basis', reason: 'No applicable method', noEstimate: 'No estimate',
      accounted: 'Accounted', tokensUnit: 'tokens', proxy: 'Proxy', proxyDetail: 'Not measured energy',
      methodTitle: 'Method', methodBody: 'Requires serving evidence',
    };
    const mount = mountThroughReactNativeWeb(<UsageFootprintBody theme={theme} labels={labels} accountedTokens="720K" />);
    try {
      expect(mount.container.textContent).toContain('720K tokens');
      await mount.render(<UsageFootprintBody theme={theme} labels={labels} />);
      expect(mount.container.textContent).toContain('Insufficient basis');
      expect(mount.container.textContent).toContain('No estimate');
      expect(mount.container.textContent).toContain('Requires serving evidence');
      expect(mount.container.textContent).not.toContain('Accounted');
      expect(mount.container.textContent).not.toContain('tokens');
      expect(mount.container.textContent).not.toContain('720K');
    } finally { mount.unmount(); }
  });

  it('renders aggregate source status rows and the host disclosure controls', () => {
    const mount = mountThroughReactNativeWeb(<UsageSourceCoverageBody theme={theme} label="Coverage"
      columns={['Source', 'Coverage']} rows={[{ title: 'Agent logs', label: 'Partial', count: 2 }]}
      showAll={<span>Show remaining sources</span>} detail={<span>Some history is unavailable</span>} />);
    try {
      expect(mount.container.textContent).toContain('Agent logs ×2Partial');
      expect(mount.container.textContent).toContain('Show remaining sources');
      expect(mount.container.textContent).toContain('Some history is unavailable');
    } finally { mount.unmount(); }
  });
});
