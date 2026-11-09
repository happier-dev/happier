/*! LiteLLM root catalog snapshot, immutable upstream commit 729b02d05719715f4faeb1f81ef2728ef06c3273.
Standard text-token rates only; no alternate tier/region/cache-duration prices.
Portions of this software are licensed as follows:

* All content that resides under the "enterprise/" directory of this repository, if that directory exists, is licensed under the license defined in "enterprise/LICENSE".
* Content outside of the above mentioned directories or restrictions above is available under the MIT license as defined below.
---
MIT License

Copyright (c) 2023 Berri AI

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
import bundledSnapshot from './usageModelPriceSnapshot.json' with { type: 'json' };
import type { UsageModelPriceCatalog } from './usageModelPriceSchemas.js';

type BundledUsageModelPriceSnapshot = Readonly<{
  v: UsageModelPriceCatalog['v'];
  models: Readonly<Record<string, Readonly<UsageModelPriceCatalog['models'][string]>>>;
  provenance: Readonly<UsageModelPriceCatalog['provenance']>;
}>;

// JSON widens literal discriminants; the trusted vendored data is validated by the catalog owner.
export const LITELLM_BUNDLED_SNAPSHOT: BundledUsageModelPriceSnapshot = bundledSnapshot as BundledUsageModelPriceSnapshot;
