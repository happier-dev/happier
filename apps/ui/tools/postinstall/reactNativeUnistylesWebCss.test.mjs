import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);

function createCssState(t, { ssr = '' } = {}) {
    const dom = new JSDOM(`<!doctype html><html><head>${ssr}</head><body></body></html>`);
    const previous = { window: globalThis.window, document: globalThis.document, screen: globalThis.screen };
    const originalLoad = Module._load;
    const packageDir = path.dirname(require.resolve('react-native-unistyles/package.json'));
    const clearPackageGraph = () => {
        for (const filename of Object.keys(require.cache)) {
            if (filename.startsWith(`${packageDir}${path.sep}`)) delete require.cache[filename];
        }
    };
    t.after(() => {
        Module._load = originalLoad;
        clearPackageGraph();
        Object.assign(globalThis, previous);
        dom.window.close();
    });
    Object.assign(globalThis, { window: dom.window, document: dom.window.document, screen: dom.window.screen });
    dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    let wholeStylesheetBytes = 0;
    // JSDOM lacks the browser's style.innerText setter. Preserve its parsing
    // semantics at this DOM boundary while observing the actual text submitted.
    Object.defineProperty(dom.window.HTMLStyleElement.prototype, 'innerText', {
        get() { return this.textContent; },
        set(value) {
            if (this.id === 'unistyles-web') wholeStylesheetBytes += Buffer.byteLength(String(value), 'utf8');
            this.textContent = value;
        },
    });
    // Same OS/platform boundary as the installed orientation test; all Unistyles logic is real.
    Module._load = function (request, parent, isMain) {
        if (request === 'react-native') return { StyleSheet: { compose() {}, flatten() {}, hairlineWidth: 1 } };
        return originalLoad.call(this, request, parent, isMain);
    };
    // Initialize the real registry and its cyclic services against this DOM.
    clearPackageGraph();
    require(path.join(packageDir, 'lib/commonjs/web/index.js'));
    const { services } = require(path.join(packageDir, 'lib/commonjs/web/services.js'));
    return {
        css: services.registry.css,
        dom,
        sheet: () => dom.window.document.getElementById('unistyles-web').sheet,
        wholeStylesheetBytes: () => wholeStylesheetBytes,
    };
}

function styleRules(container, media = '') {
    if (typeof container === 'function') container = container();
    return Array.from(container.cssRules).flatMap(rule => rule.cssRules
        ? styleRules(rule, rule.conditionText === 'all' ? media : rule.conditionText)
        : [{ rule, media }]);
}

test('style registration and removal preserve unrelated live rules without resubmitting stylesheet text', (t) => {
    const { css, sheet, wholeStylesheetBytes } = createCssState(t);
    css.add('retained', { color: 'red', padding: 2 });
    const retained = styleRules(sheet).find(({ rule }) => rule.selectorText === '.retained').rule;
    const beforeBytes = wholeStylesheetBytes();
    for (let index = 0; index < 8; index += 1) {
        const hash = `temporary_${index}`;
        css.add(hash, { width: index + 1, opacity: 0.5 });
        css.remove(hash);
    }
    const remaining = styleRules(sheet);
    assert.deepEqual(remaining.map(({ rule }) => rule.selectorText), ['.retained']);
    assert.equal(remaining[0].rule.style.color, 'red');
    assert.equal(remaining[0].rule.style.getPropertyValue('padding'), '2px');
    assert.equal(wholeStylesheetBytes() - beforeBytes, 0, 'unrelated registration churn must not resubmit stylesheet text');
    assert.equal(remaining[0].rule, retained, 'the unchanged retained CSSRule must remain live');
});

test('incremental styles preserve media order, pseudo selectors, child selectors and replacements', (t) => {
    const { css, sheet } = createCssState(t);
    css.add('first', { color: 'red', _hover: { color: 'blue' } });
    css.add('children > *', { margin: 4 });
    css.set({ mediaQuery: '@media (min-width: 600px)', className: 'first', propertyKey: 'color', value: 'green' });
    css.set({ mediaQuery: '@media (min-width: 900px)', className: 'first', propertyKey: 'color', value: 'orange' });
    css.recreate();
    css.add('first', { color: 'purple' });
    const rules = styleRules(sheet);
    assert.equal(rules.find(({ rule, media }) => !media && rule.selectorText === '.first').rule.style.color, 'purple');
    assert.equal(rules.find(({ rule }) => rule.selectorText === '.first:hover').rule.style.color, 'blue');
    assert.equal(rules.find(({ rule }) => rule.selectorText === '.children > *').rule.style.margin, '4px');
    assert.deepEqual(rules.filter(({ media }) => media).map(({ rule, media }) => [media, rule.style.color]), [
        ['(min-width: 600px)', 'green'], ['(min-width: 900px)', 'orange'],
    ]);
    css.remove('first');
    assert.equal(styleRules(sheet).filter(({ rule }) => rule.selectorText === '.first').length, 0);
    css.add('first', { color: 'pink' });
    assert.equal(styleRules(sheet).find(({ rule }) => rule.selectorText === '.first').rule.style.color, 'pink');
    css.set({ className: 'first', propertyKey: 'color', value: undefined });
    assert.equal(styleRules(sheet).find(({ rule }) => rule.selectorText === '.first').rule.style.color, '');
    css.set({ className: 'first', propertyKey: 'color', value: 'red !important' });
    assert.equal(styleRules(sheet).find(({ rule }) => rule.selectorText === '.first').rule.style.getPropertyPriority('color'), 'important');
});

test('theme rebuilds retain the cascade position of empty media buckets', (t) => {
    const { css, sheet } = createCssState(t);
    css.add('reused', { color: 'red' });
    css.set({ mediaQuery: '@media (min-width: 600px)', className: 'reused', propertyKey: 'color', value: 'green' });
    css.recreate();
    css.remove('reused');
    css.recreate();
    css.set({ mediaQuery: '@media (min-width: 600px)', className: 'reused', propertyKey: 'color', value: 'green' });
    css.add('reused', { color: 'red' });
    assert.deepEqual(styleRules(sheet).map(({ rule, media }) => [media, rule.style.color]), [
        ['', 'red'], ['(min-width: 600px)', 'green'],
    ]);
});

test('SSR hydration, theme recreation and reset keep the authoritative maps and live rules aligned', (t) => {
    const { css, sheet } = createCssState(t, { ssr: '<style id="unistyles-web">.hydrated{color:red}</style>' });
    css.hydrate({ mainState: [['', [['hydrated', [['color', 'red']]]]]], mqState: [] });
    css.addTheme('light', { colors: { foreground: 'red' } });
    css.recreate();
    css.add('after', { color: 'var(--colors-foreground)' });
    assert.equal(styleRules(sheet).filter(({ rule }) => rule.selectorText === '.hydrated').length, 1);
    assert.equal(styleRules(sheet).find(({ rule }) => rule.selectorText === '.after').rule.style.color, 'var(--colors-foreground)');
    css.addTheme('light', { colors: { foreground: 'blue' } });
    css.recreate();
    assert.equal(styleRules(sheet).find(({ rule }) => rule.selectorText.includes(':root.light')).rule.style.getPropertyValue('--colors-foreground'), 'blue');
    css.reset();
    css.add('reset', { color: 'green' });
    const classes = styleRules(sheet).map(({ rule }) => rule.selectorText).filter(selector => selector.startsWith('.'));
    assert.deepEqual(classes, ['.reset']);
    assert.equal(css.getStyles().includes('.hydrated'), false);
});

// Upgrade regression: 3.5.3 emits zero-specificity child selectors for pointerEvents.
test('pointer-event child rules stay valid and are removed with their owning style', (t) => {
    const { css, sheet } = createCssState(t);
    css.add('retained', { color: 'red' });
    const retained = styleRules(sheet).find(({ rule }) => rule.selectorText === '.retained').rule;
    css.add('overlay', { pointerEvents: 'box-none' });
    let rules = styleRules(sheet);
    assert.equal(rules.find(({ rule }) => rule.selectorText === '.overlay').rule.style.getPropertyValue('pointer-events'), 'none');
    assert.equal(rules.find(({ rule }) => rule.selectorText === ':where(.overlay)>*').rule.style.getPropertyValue('pointer-events'), 'auto');
    css.add('overlay', { pointerEvents: 'box-only' });
    rules = styleRules(sheet);
    assert.equal(rules.find(({ rule }) => rule.selectorText === '.overlay').rule.style.getPropertyValue('pointer-events'), 'auto');
    assert.equal(rules.find(({ rule }) => rule.selectorText === ':where(.overlay)>*').rule.style.getPropertyValue('pointer-events'), 'none');
    css.remove('overlay');
    rules = styleRules(sheet);
    assert.equal(rules.some(({ rule }) => rule.selectorText.includes('overlay')), false);
    assert.equal(rules.find(({ rule }) => rule.selectorText === '.retained').rule, retained);
});

test('incremental CSS keeps upstream scoped-theme and reset variable selectors', (t) => {
    const { css, sheet } = createCssState(t);
    css.addTheme('light', { colors: { foreground: 'red' } });
    css.recreate();
    const themes = styleRules(sheet).filter(({ rule }) => rule.style?.getPropertyValue('--colors-foreground') === 'red');
    assert.equal(themes.some(({ rule }) => rule.selectorText.includes('[data-unistyles-theme="light"]')), true);
    assert.equal(themes.some(({ rule }) => rule.selectorText.includes('[data-unistyles-reset]')), true);
});
