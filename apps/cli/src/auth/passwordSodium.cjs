// Use the package's public require export: 0.7.16's ESM wrapper references an
// unshipped sibling. A literal require keeps sodium in both bundlers' graphs.
module.exports = require('libsodium-wrappers-sumo');
