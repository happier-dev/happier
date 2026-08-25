import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
    BrowserAutomationActionKindV1Schema,
    BrowserAutomationAdapterCapabilityKindV1Schema,
    type BrowserAdapterCapabilitiesV1,
    type BrowserAutomationActionCapabilityMapV1,
    type BrowserAutomationAdapterCapabilityKindV1,
    type BrowserRenderEngineKindV1,
    type BrowserSemanticAdapterKindV1,
    type BrowserViewTargetKindV1,
} from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { buildBrowserAdapterCapabilities } from './capabilities';
import type { DesktopWebViewSupport } from './desktopWebView';

/**
 * UB-1. The 21-verb automation protocol advertises far more than any surface actually performs,
 * and until this test existed the real matrix was undocumented — an agent had to dispatch a verb
 * to discover it was dead. `docs/browser-automation-verb-matrix.md` is the published answer, and
 * this test RENDERS that table from {@link buildBrowserAdapterCapabilities} and compares it to the
 * committed bytes. There is no hand-maintained second table: change the capability builder and
 * this test fails until the doc is regenerated from it.
 */

const DOC_PATH = join(__dirname, '../../../../../../../docs/browser-automation-verb-matrix.md');
const TABLE_START = '<!-- BEGIN GENERATED: automation-verb-matrix -->';
const TABLE_END = '<!-- END GENERATED: automation-verb-matrix -->';

const FULL_DESKTOP_SUPPORT: DesktopWebViewSupport = {
    navigation: true,
    goBackForward: true,
    reload: true,
    stop: true,
    pageInfoDiagnostics: true,
    nativeDevtools: true,
    capture: true,
    recording: false,
    automation: false,
};

type Surface = Readonly<{
    label: string;
    adapterKind: BrowserSemanticAdapterKindV1;
    supportedTargetKinds: readonly BrowserViewTargetKindV1[];
    supportedRenderEngines: readonly BrowserRenderEngineKindV1[];
    desktopWebViewSupport?: DesktopWebViewSupport | null;
}>;

/** Every surface the product can actually mount, in the shape its owner builds it. */
const SURFACES: readonly Surface[] = [
    {
        label: 'External URL · web (`webIframe`)',
        adapterKind: 'externalUrl',
        supportedTargetKinds: ['externalUrl'],
        supportedRenderEngines: ['webIframe'],
    },
    {
        label: 'External URL · iOS/Android (`nativeWebView`)',
        adapterKind: 'externalUrl',
        supportedTargetKinds: ['externalUrl'],
        supportedRenderEngines: ['nativeWebView'],
    },
    {
        label: 'External URL · desktop (`desktopWebView`)',
        adapterKind: 'externalUrl',
        supportedTargetKinds: ['externalUrl'],
        supportedRenderEngines: ['desktopWebView'],
        desktopWebViewSupport: FULL_DESKTOP_SUPPORT,
    },
    {
        label: 'Local service preview · web (`webIframe`)',
        adapterKind: 'localPreview',
        supportedTargetKinds: ['localServicePreview'],
        supportedRenderEngines: ['webIframe'],
    },
    {
        label: 'Local service preview · native (`nativeWebView`)',
        adapterKind: 'localPreview',
        supportedTargetKinds: ['localServicePreview'],
        supportedRenderEngines: ['nativeWebView'],
    },
    {
        label: 'Hosted plugin web view',
        adapterKind: 'hostedPlugin',
        supportedTargetKinds: ['hostedPluginWeb'],
        supportedRenderEngines: ['webIframe'],
    },
    {
        label: 'Simulator preview',
        adapterKind: 'simulatorPreview',
        supportedTargetKinds: ['simulatorPreview'],
        supportedRenderEngines: ['streamedSurface'],
    },
    {
        // DEC-5: the streamed adapter is contracted, so there is no longer a "live" variant of this
        // surface — it is always the fail-closed one.
        label: 'Streamed browser surface (contracted, fail-closed)',
        adapterKind: 'streamedBrowserSurface',
        supportedTargetKinds: ['streamedBrowser'],
        supportedRenderEngines: ['streamedSurface'],
    },
    {
        label: 'Chromium sidecar (no UI-reachable runtime)',
        adapterKind: 'chromiumSidecar',
        supportedTargetKinds: ['externalUrl'],
        supportedRenderEngines: ['unavailable'],
    },
];

const CAPABILITY_KINDS = BrowserAutomationAdapterCapabilityKindV1Schema.options;

function capabilitiesFor(surface: Surface): BrowserAdapterCapabilitiesV1 {
    return buildBrowserAdapterCapabilities({
        adapterKind: surface.adapterKind,
        supportedTargetKinds: surface.supportedTargetKinds,
        supportedRenderEngines: surface.supportedRenderEngines,
        ...(surface.desktopWebViewSupport === undefined
            ? {}
            : { desktopWebViewSupport: surface.desktopWebViewSupport }),
    });
}

/**
 * `automationActions` is optional on the schema, so a surface that produced none would silently
 * render as an empty row. Every surface must declare the full map — that is the point of the
 * matrix — so an absent map is a builder defect, not an empty cell.
 */
function automationActionsFor(surface: Surface): BrowserAutomationActionCapabilityMapV1 {
    const actions = capabilitiesFor(surface).automationActions;
    if (!actions) {
        throw new Error(`buildBrowserAdapterCapabilities returned no automationActions for ${surface.label}`);
    }
    return actions;
}

function availableVerbs(actions: BrowserAutomationActionCapabilityMapV1): readonly string[] {
    return CAPABILITY_KINDS.filter((kind) => actions[kind].available === true);
}

function disabledReasons(actions: BrowserAutomationActionCapabilityMapV1): readonly string[] {
    const reasons = new Set<string>();
    for (const kind of CAPABILITY_KINDS) {
        for (const reason of actions[kind].disabledReasons) {
            reasons.add(reason);
        }
    }
    return [...reasons].sort();
}

function cell(values: readonly string[]): string {
    return values.length < 1 ? '_none_' : values.map((value) => `\`${value}\``).join(', ');
}

function renderSurfaceTable(): readonly string[] {
    return [
        '| Surface | Automation verbs available | Disabled reasons reported |',
        '|---|---|---|',
        ...SURFACES.map((surface) => {
            const actions = automationActionsFor(surface);
            return `| ${surface.label} | ${cell(availableVerbs(actions))} | ${cell(disabledReasons(actions))} |`;
        }),
    ];
}

function renderVerbTable(): readonly string[] {
    return [
        '| Capability | Available on | Reason where unavailable |',
        '|---|---|---|',
        ...CAPABILITY_KINDS.map((kind) => {
            const surfaces: string[] = [];
            const reasons = new Set<string>();
            for (const surface of SURFACES) {
                const capability = automationActionsFor(surface)[kind];
                if (capability.available === true) {
                    surfaces.push(surface.label);
                    continue;
                }
                for (const reason of capability.disabledReasons) reasons.add(reason);
            }
            const availableOn = surfaces.length < 1
                ? '**nowhere**'
                : surfaces.length === SURFACES.length
                    ? 'every surface'
                    : surfaces.join('<br>');
            return `| \`${kind}\` | ${availableOn} | ${cell([...reasons].sort())} |`;
        }),
    ];
}

function renderMatrix(): string {
    const uncovered = BrowserAutomationActionKindV1Schema.options.filter((actionKind) => (
        !(CAPABILITY_KINDS as readonly string[]).includes(actionKind)
    ));
    return [
        '### Surfaces',
        '',
        ...renderSurfaceTable(),
        '',
        '### Capabilities',
        '',
        ...renderVerbTable(),
        '',
        `Action kinds with no capability bit of their own: ${cell(uncovered)}. `
        + 'They ride the surface\'s general synthetic-input path — navigation kinds are gated by '
        + '`navigation.*` instead, and the rest resolve with the same injected-page runtime that '
        + 'backs `click`.',
    ].join('\n');
}

function readDocMatrix(): string {
    const doc = readFileSync(DOC_PATH, 'utf8');
    const start = doc.indexOf(TABLE_START);
    const end = doc.indexOf(TABLE_END);
    expect(start, `${DOC_PATH} is missing ${TABLE_START}`).toBeGreaterThanOrEqual(0);
    expect(end, `${DOC_PATH} is missing ${TABLE_END}`).toBeGreaterThan(start);
    return doc.slice(start + TABLE_START.length, end).trim();
}

/**
 * Regeneration path. The doc is derived, so when the capability builder legitimately changes the
 * answer must be re-rendered, not hand-patched from a test diff:
 *
 *     UPDATE_AUTOMATION_VERB_MATRIX=1 vitest run sources/sync/domains/browser/adapters/automationVerbMatrix.closure.test.ts
 *
 * Without the variable this is a pure comparison, so CI still fails on drift.
 */
function writeDocMatrix(matrix: string): void {
    const doc = readFileSync(DOC_PATH, 'utf8');
    const start = doc.indexOf(TABLE_START);
    const end = doc.indexOf(TABLE_END);
    expect(start, `${DOC_PATH} is missing ${TABLE_START}`).toBeGreaterThanOrEqual(0);
    expect(end, `${DOC_PATH} is missing ${TABLE_END}`).toBeGreaterThan(start);
    writeFileSync(
        DOC_PATH,
        `${doc.slice(0, start + TABLE_START.length)}\n${matrix}\n${doc.slice(end)}`,
        'utf8',
    );
}

describe('browser automation verb matrix (UB-1)', () => {
    it('publishes the matrix the capability builder actually produces', () => {
        const matrix = renderMatrix();
        if (process.env.UPDATE_AUTOMATION_VERB_MATRIX === '1') writeDocMatrix(matrix);
        expect(readDocMatrix()).toBe(matrix);
    });

    it('covers every capability kind the protocol declares', () => {
        // A new capability kind must appear in the rendered rows, so the doc cannot silently omit
        // a verb the protocol advertises.
        const rendered = renderMatrix();
        const declared: readonly BrowserAutomationAdapterCapabilityKindV1[] = CAPABILITY_KINDS;
        const missing = declared.filter((kind) => !rendered.includes(`\`${kind}\``));
        expect(missing).toEqual([]);
    });

    it('keeps every desktop and streamed surface honest about why a verb is off', () => {
        // The failure mode UB-1 names: a surface that reports zero available verbs and zero
        // reasons is a silent dead end for an agent.
        for (const surface of SURFACES) {
            const actions = automationActionsFor(surface);
            if (availableVerbs(actions).length > 0) continue;
            expect(disabledReasons(actions), `${surface.label} disables everything with no reason`)
                .not.toEqual([]);
        }
    });
});
