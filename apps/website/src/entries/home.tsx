import { mount } from './_mount';

/**
 * `/` — the client entry for the homepage, and the template for all of them.
 *
 * An entry names ONE page and hands it to mount(). It must not import
 * src/routes.tsx: that file reaches every page component on the site, which is
 * the single import that would put all 21 pages back in one download.
 *
 * The locale is a literal because the file is per (route, locale): the day `/`
 * gains a translation, src/routes.tsx grows `locales`, routeManifest() emits a
 * second entry for it, and the build asks for src/entries/zh-Hans--home.tsx.
 */
mount('en');
