import { STREAM_WEBVIEW_BUNDLE } from './bundle.generated';

export const STREAM_WEBVIEW_SOURCE = {
    baseUrl: 'https://localhost',
    html: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}</style></head><body><div id="root"></div><script>${STREAM_WEBVIEW_BUNDLE.replace(/<\/script/giu, '<\\/script')}</script></body></html>`,
};
