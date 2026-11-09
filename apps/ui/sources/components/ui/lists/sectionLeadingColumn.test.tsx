import * as React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';

import { SectionLeadingColumnProvider, useIsInsideItemSection, useSectionLeadingColumn } from './sectionLeadingColumn';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Counts = { commits: number; renders: Record<string, number>; reserve: Record<string, boolean> };

function Row(props: Readonly<{ id: string; leading: boolean; counts: Counts }>) {
    const reserve = useSectionLeadingColumn(props.leading);
    props.counts.renders[props.id] = (props.counts.renders[props.id] ?? 0) + 1;
    props.counts.reserve[props.id] = reserve;
    return null;
}

function SectionNotice(props: Readonly<{ counts: Counts }>) {
    useIsInsideItemSection();
    props.counts.renders.notice = (props.counts.renders.notice ?? 0) + 1;
    return null;
}

function Section(props: Readonly<{ counts: Counts; rows: ReadonlyArray<Readonly<{ id: string; leading: boolean }>> }>) {
    return (
        <React.Profiler id="section" onRender={() => { props.counts.commits += 1; }}>
            <SectionLeadingColumnProvider>
                <SectionNotice counts={props.counts} />
                {props.rows.map((row) => <Row key={row.id} id={row.id} leading={row.leading} counts={props.counts} />)}
            </SectionLeadingColumnProvider>
        </React.Profiler>
    );
}

function newCounts(): Counts {
    return { commits: 0, renders: {}, reserve: {} };
}

describe('section leading column', () => {
    it('registers rows without republishing the section when the leading column does not change', () => {
        const counts = newCounts();
        const rows = [{ id: 'icon-0', leading: true }, { id: 'plain', leading: false }];
        let renderer!: ReactTestRenderer;
        act(() => { renderer = create(<Section counts={counts} rows={rows} />); });
        expect(counts.reserve.plain).toBe(true);

        const before = { commits: counts.commits, notice: counts.renders.notice, plain: counts.renders.plain };
        const added = 5;
        for (let i = 1; i <= added; i += 1) {
            rows.push({ id: `icon-${i}`, leading: true });
            act(() => { renderer.update(<Section counts={counts} rows={[...rows]} />); });
            // The new row draws with its column on its first render: no second pass after it registers.
            expect(counts.renders[`icon-${i}`]).toBe(1);
        }
        // One commit per added row (its own mount); registration adds no section render or consumer wake.
        expect(counts.commits - before.commits).toBe(added);
        // The parent re-render reaches the unmemoized test rows; what matters is no registration-driven extra pass.
        expect(counts.renders.notice - before.notice).toBe(added);
        expect(counts.renders.plain - before.plain).toBe(added);
        act(() => { renderer.unmount(); });
    });

    it('draws a leading row with its column on its first render and wakes only rows whose column changes', () => {
        const counts = newCounts();
        let renderer!: ReactTestRenderer;
        act(() => { renderer = create(<Section counts={counts} rows={[{ id: 'icon', leading: true }]} />); });
        expect(counts.renders.icon).toBe(1);
        expect(counts.reserve.icon).toBe(true);
        // "Inside a section" never changes, so the notice is not woken by the column decision.
        expect(counts.renders.notice).toBe(1);
        expect(counts.commits).toBe(1);
        act(() => { renderer.unmount(); });
    });

    it('still publishes a real change of the leading column to rows without their own leading element', () => {
        const counts = newCounts();
        let renderer!: ReactTestRenderer;
        const Mounted = (props: Readonly<{ withIcon: boolean }>) => (
            <Section counts={counts} rows={props.withIcon ? [{ id: 'plain', leading: false }, { id: 'icon', leading: true }] : [{ id: 'plain', leading: false }]} />
        );
        act(() => { renderer = create(<Mounted withIcon={false} />); });
        expect(counts.reserve.plain).toBe(false);
        act(() => { renderer.update(<Mounted withIcon />); });
        expect(counts.reserve.plain).toBe(true);
        act(() => { renderer.update(<Mounted withIcon={false} />); });
        expect(counts.reserve.plain).toBe(false);
        act(() => { renderer.unmount(); });
    });

    it('keeps rows outside a section on their own leading element', () => {
        const counts = newCounts();
        act(() => { create(<><Row id="plain" leading={false} counts={counts} /><Row id="icon" leading counts={counts} /></>); });
        expect(counts.reserve.plain).toBe(false);
        expect(counts.reserve.icon).toBe(false);
    });
});
