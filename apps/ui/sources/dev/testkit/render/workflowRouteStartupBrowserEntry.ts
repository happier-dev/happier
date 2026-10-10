declare const require: (id: string) => unknown;

// A separate entry prevents hoisted harness imports from evaluating Router or
// the stores before the real index installs the eager browser-history owner.
require('../../../../index');
require('./workflowRouteStartupBrowserApp');

export {};
