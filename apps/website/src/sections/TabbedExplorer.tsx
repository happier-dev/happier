import { useState } from 'react';
import { trackDemoPlayed } from '../analytics/events';
import { RevealText } from '../components/RevealText';
import { Picture } from '../components/Picture';
import { rich } from '../i18n/rich';
import { useSiteData } from '../i18n/siteData';

const TABS = [
    {
        id: 'chat',
        label: 'Chat',
        screenshot: 'showcaseDesktop',
    },
    {
        id: 'editor',
        label: 'Editor',
        screenshot: 'showcaseDesktop',
    },
    {
        id: 'git',
        label: 'Git',
        screenshot: 'showcaseDesktop',
    },
    {
        id: 'terminal',
        label: 'Terminal',
        screenshot: 'showcaseDesktop',
    },
] as const;

type TabId = (typeof TABS)[number]['id'];

export function TabbedExplorer() {
    const { pageProse: { PAGE_PROSE } } = useSiteData();

    const [activeTab, setActiveTab] = useState<TabId>(TABS[0].id);
    const active = TABS.find((t) => t.id === activeTab) ?? TABS[0];

    return (
        <section className="relative" data-section="explorer">
            <div className="section-y mx-auto max-w-[1400px] px-6 md:px-10">
                <div className="section-head mx-auto max-w-[760px] text-center">
                    <div
                        className="mb-5 text-[11.5px] font-semibold uppercase tracking-[0.18em]"
                        style={{ color: 'var(--muted)' }}
                    >{rich(PAGE_PROSE.tabbedExplorer.p0)}</div>
                    <RevealText
                        as="h2"
                        text={'Every tool.\nOne interface.'}
                        className="font-display text-[36px] font-normal leading-[1.06] tracking-[-0.025em] md:text-[48px] lg:text-[56px]"
                        stagger={60}
                    />
                </div>

                <div className="mx-auto flex justify-center">
                    <div
                        className="mb-8 inline-flex gap-1 rounded-full border p-1"
                        style={{ borderColor: 'var(--card-border)' }}
                    >
                        {TABS.map((tab) => (
                            <button
                                key={tab.id}
                                /* `demo_played` had no call site. The tab strip is
                                   the only interactive demo surface on the page, so
                                   this is the whole of "did anyone actually look at
                                   the product?" — and the answer is what decides
                                   whether this section keeps its place. */
                                onClick={() => {
                                    setActiveTab(tab.id);
                                    trackDemoPlayed({
                                        demo: 'tabbed-explorer',
                                        action: 'tab',
                                        detail: tab.id,
                                    });
                                }}
                                className="rounded-full px-5 py-2 text-[14px] font-medium transition-all"
                                style={{
                                    background: tab.id === activeTab ? 'var(--fg)' : 'transparent',
                                    color: tab.id === activeTab ? 'var(--bg)' : 'var(--muted)',
                                }}
                            >
                                {tab.label}
                            </button>
                        ))}
                    </div>
                </div>

                {/* The screenshots already include the app's own window chrome,
                    rounded corners, and a baked drop-shadow — so we render them
                    directly with no wrapper chrome (which would duplicate it). */}
                <div className="mx-auto max-w-[1100px]">
                    <Picture
                        key={active.id}
                        id={active.screenshot}
                        alt={`Happier ${active.label} view`}
                        className="block w-full"
                        imgClassName="w-full select-none"
                        draggable={false}
                    />
                </div>
            </div>
        </section>
    );
}
