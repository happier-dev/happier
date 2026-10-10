/* LiteLLM root catalog snapshot, immutable upstream commit 729b02d05719715f4faeb1f81ef2728ef06c3273.
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
export const LITELLM_BUNDLED_SNAPSHOT = {
  "v": 1,
  "models": {
    "ai21.j2-mid-v1": {
      "inputUsdPerMillion": 12.5,
      "outputUsdPerMillion": 12.5,
      "provider": "bedrock",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "ai21.j2-ultra-v1": {
      "inputUsdPerMillion": 18.8,
      "outputUsdPerMillion": 18.8,
      "provider": "bedrock",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "ai21.jamba-1-5-large-v1:0": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 8,
      "provider": "bedrock",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "ai21.jamba-1-5-mini-v1:0": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.39999999999999997,
      "provider": "bedrock",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "ai21.jamba-instruct-v1:0": {
      "inputUsdPerMillion": 0.5,
      "outputUsdPerMillion": 0.7,
      "provider": "bedrock",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "us.writer.palmyra-x4-v1:0": {
      "inputUsdPerMillion": 2.5,
      "outputUsdPerMillion": 10,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "us.writer.palmyra-x5-v1:0": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 6,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "writer.palmyra-x4-v1:0": {
      "inputUsdPerMillion": 2.5,
      "outputUsdPerMillion": 10,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "writer.palmyra-x5-v1:0": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 6,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "writer.palmyra-vision-7b": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.6,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "amazon.nova-lite-v1:0": {
      "inputUsdPerMillion": 0.06,
      "outputUsdPerMillion": 0.24,
      "cacheReadUsdPerMillion": 0.015,
      "provider": "bedrock_converse"
    },
    "amazon.nova-2-lite-v1:0": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 2.5,
      "cacheReadUsdPerMillion": 0.075,
      "provider": "bedrock_converse"
    },
    "amazon.nova-2-pro-preview-20251202-v1:0": {
      "inputUsdPerMillion": 1.25,
      "outputUsdPerMillion": 10,
      "cacheReadUsdPerMillion": 0.3125,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/nova/pricing/"
    },
    "apac.amazon.nova-2-lite-v1:0": {
      "inputUsdPerMillion": 0.33,
      "outputUsdPerMillion": 2.75,
      "cacheReadUsdPerMillion": 0.0825,
      "provider": "bedrock_converse"
    },
    "apac.amazon.nova-2-pro-preview-20251202-v1:0": {
      "inputUsdPerMillion": 1.375,
      "outputUsdPerMillion": 11,
      "cacheReadUsdPerMillion": 0.34375,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/nova/pricing/"
    },
    "eu.amazon.nova-2-lite-v1:0": {
      "inputUsdPerMillion": 0.33,
      "outputUsdPerMillion": 2.75,
      "cacheReadUsdPerMillion": 0.0825,
      "provider": "bedrock_converse"
    },
    "eu.amazon.nova-2-pro-preview-20251202-v1:0": {
      "inputUsdPerMillion": 1.375,
      "outputUsdPerMillion": 11,
      "cacheReadUsdPerMillion": 0.34375,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/nova/pricing/"
    },
    "us.amazon.nova-2-lite-v1:0": {
      "inputUsdPerMillion": 0.33,
      "outputUsdPerMillion": 2.75,
      "cacheReadUsdPerMillion": 0.0825,
      "provider": "bedrock_converse"
    },
    "us.amazon.nova-2-pro-preview-20251202-v1:0": {
      "inputUsdPerMillion": 1.375,
      "outputUsdPerMillion": 11,
      "cacheReadUsdPerMillion": 0.34375,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/nova/pricing/"
    },
    "amazon.nova-micro-v1:0": {
      "inputUsdPerMillion": 0.035,
      "outputUsdPerMillion": 0.14,
      "cacheReadUsdPerMillion": 0.00875,
      "provider": "bedrock_converse"
    },
    "amazon.nova-pro-v1:0": {
      "inputUsdPerMillion": 0.7999999999999999,
      "outputUsdPerMillion": 3.1999999999999997,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "provider": "bedrock_converse"
    },
    "amazon.titan-text-express-v1": {
      "inputUsdPerMillion": 1.3,
      "outputUsdPerMillion": 1.7,
      "provider": "bedrock"
    },
    "amazon.titan-text-lite-v1": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 0.39999999999999997,
      "provider": "bedrock"
    },
    "amazon.titan-text-premier-v1:0": {
      "inputUsdPerMillion": 0.5,
      "outputUsdPerMillion": 1.5,
      "provider": "bedrock"
    },
    "anthropic.claude-3-5-haiku-20241022-v1:0": {
      "inputUsdPerMillion": 0.7999999999999999,
      "outputUsdPerMillion": 4,
      "cacheReadUsdPerMillion": 0.08,
      "cacheWriteUsdPerMillion": 1,
      "provider": "bedrock"
    },
    "anthropic.claude-haiku-4-5-20251001-v1:0": {
      "inputUsdPerMillion": 1,
      "outputUsdPerMillion": 5,
      "cacheReadUsdPerMillion": 0.09999999999999999,
      "cacheWriteUsdPerMillion": 1.25,
      "provider": "bedrock_converse",
      "sourceUrl": "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrockFoundationModels/current/index.json"
    },
    "anthropic.claude-haiku-4-5@20251001": {
      "inputUsdPerMillion": 1,
      "outputUsdPerMillion": 5,
      "cacheReadUsdPerMillion": 0.09999999999999999,
      "cacheWriteUsdPerMillion": 1.25,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/about-aws/whats-new/2025/10/claude-4-5-haiku-anthropic-amazon-bedrock"
    },
    "anthropic.claude-3-5-sonnet-20240620-v1:0": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 15,
      "cacheReadUsdPerMillion": 0.3,
      "cacheWriteUsdPerMillion": 3.75,
      "provider": "bedrock"
    },
    "anthropic.claude-3-5-sonnet-20241022-v2:0": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 15,
      "cacheReadUsdPerMillion": 0.3,
      "cacheWriteUsdPerMillion": 3.75,
      "provider": "bedrock"
    },
    "anthropic.claude-3-7-sonnet-20240620-v1:0": {
      "inputUsdPerMillion": 3.5999999999999996,
      "outputUsdPerMillion": 18,
      "cacheReadUsdPerMillion": 0.36,
      "cacheWriteUsdPerMillion": 4.5,
      "provider": "bedrock"
    },
    "anthropic.claude-3-7-sonnet-20250219-v1:0": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 15,
      "cacheReadUsdPerMillion": 0.3,
      "cacheWriteUsdPerMillion": 3.75,
      "provider": "bedrock_converse"
    },
    "anthropic.claude-3-opus-20240229-v1:0": {
      "inputUsdPerMillion": 15,
      "outputUsdPerMillion": 75,
      "cacheReadUsdPerMillion": 1.5,
      "cacheWriteUsdPerMillion": 18.75,
      "provider": "bedrock"
    },
    "anthropic.claude-instant-v1": {
      "inputUsdPerMillion": 0.7999999999999999,
      "outputUsdPerMillion": 2.4,
      "provider": "bedrock"
    },
    "anthropic.claude-opus-4-1-20250805-v1:0": {
      "inputUsdPerMillion": 15,
      "outputUsdPerMillion": 75,
      "cacheReadUsdPerMillion": 1.5,
      "cacheWriteUsdPerMillion": 18.75,
      "provider": "bedrock_converse"
    },
    "anthropic.claude-opus-4-20250514-v1:0": {
      "inputUsdPerMillion": 15,
      "outputUsdPerMillion": 75,
      "cacheReadUsdPerMillion": 1.5,
      "cacheWriteUsdPerMillion": 18.75,
      "provider": "bedrock_converse"
    },
    "anthropic.claude-opus-4-5-20251101-v1:0": {
      "inputUsdPerMillion": 5,
      "outputUsdPerMillion": 25,
      "cacheReadUsdPerMillion": 0.5,
      "cacheWriteUsdPerMillion": 6.25,
      "provider": "bedrock_converse",
      "sourceUrl": "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrockFoundationModels/current/index.json"
    },
    "anthropic.claude-opus-4-6-v1": {
      "inputUsdPerMillion": 5,
      "outputUsdPerMillion": 25,
      "cacheReadUsdPerMillion": 0.5,
      "cacheWriteUsdPerMillion": 6.25,
      "provider": "bedrock_converse",
      "sourceUrl": "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrockFoundationModels/current/index.json"
    },
    "global.anthropic.claude-opus-4-6-v1": {
      "inputUsdPerMillion": 5,
      "outputUsdPerMillion": 25,
      "cacheReadUsdPerMillion": 0.5,
      "cacheWriteUsdPerMillion": 6.25,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "us.anthropic.claude-opus-4-6-v1": {
      "inputUsdPerMillion": 5.5,
      "outputUsdPerMillion": 27.5,
      "cacheReadUsdPerMillion": 0.55,
      "cacheWriteUsdPerMillion": 6.875,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "eu.anthropic.claude-opus-4-6-v1": {
      "inputUsdPerMillion": 5.5,
      "outputUsdPerMillion": 27.5,
      "cacheReadUsdPerMillion": 0.55,
      "cacheWriteUsdPerMillion": 6.875,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "au.anthropic.claude-opus-4-6-v1": {
      "inputUsdPerMillion": 5.5,
      "outputUsdPerMillion": 27.5,
      "cacheReadUsdPerMillion": 0.55,
      "cacheWriteUsdPerMillion": 6.875,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "anthropic.claude-opus-4-7": {
      "inputUsdPerMillion": 5,
      "outputUsdPerMillion": 25,
      "cacheReadUsdPerMillion": 0.5,
      "cacheWriteUsdPerMillion": 6.25,
      "provider": "bedrock_converse",
      "sourceUrl": "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrockFoundationModels/current/index.json"
    },
    "anthropic.claude-mythos-preview": {
      "inputUsdPerMillion": 27.5,
      "outputUsdPerMillion": 137.5,
      "cacheReadUsdPerMillion": 2.75,
      "cacheWriteUsdPerMillion": 34.375,
      "provider": "bedrock",
      "sourceUrl": "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrockFoundationModels/current/index.json"
    },
    "global.anthropic.claude-opus-4-7": {
      "inputUsdPerMillion": 5,
      "outputUsdPerMillion": 25,
      "cacheReadUsdPerMillion": 0.5,
      "cacheWriteUsdPerMillion": 6.25,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "us.anthropic.claude-opus-4-7": {
      "inputUsdPerMillion": 5.5,
      "outputUsdPerMillion": 27.5,
      "cacheReadUsdPerMillion": 0.55,
      "cacheWriteUsdPerMillion": 6.875,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "eu.anthropic.claude-opus-4-7": {
      "inputUsdPerMillion": 5.5,
      "outputUsdPerMillion": 27.5,
      "cacheReadUsdPerMillion": 0.55,
      "cacheWriteUsdPerMillion": 6.875,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "au.anthropic.claude-opus-4-7": {
      "inputUsdPerMillion": 5.5,
      "outputUsdPerMillion": 27.5,
      "cacheReadUsdPerMillion": 0.55,
      "cacheWriteUsdPerMillion": 6.875,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "anthropic.claude-fable-5": {
      "inputUsdPerMillion": 10,
      "outputUsdPerMillion": 50,
      "cacheReadUsdPerMillion": 1,
      "cacheWriteUsdPerMillion": 12.5,
      "provider": "bedrock_converse",
      "sourceUrl": "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrockFoundationModels/current/index.json"
    },
    "anthropic.claude-fable-5-1": {
      "inputUsdPerMillion": 10,
      "outputUsdPerMillion": 50,
      "cacheReadUsdPerMillion": 0.25,
      "cacheWriteUsdPerMillion": 12.5,
      "provider": "bedrock_converse",
      "sourceUrl": "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrockFoundationModels/current/index.json"
    },
    "global.anthropic.claude-fable-5": {
      "inputUsdPerMillion": 10,
      "outputUsdPerMillion": 50,
      "cacheReadUsdPerMillion": 1,
      "cacheWriteUsdPerMillion": 12.5,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "global.anthropic.claude-fable-5-1": {
      "inputUsdPerMillion": 10,
      "outputUsdPerMillion": 50,
      "cacheReadUsdPerMillion": 0.25,
      "cacheWriteUsdPerMillion": 12.5,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "us.anthropic.claude-fable-5": {
      "inputUsdPerMillion": 11,
      "outputUsdPerMillion": 55,
      "cacheReadUsdPerMillion": 1.1,
      "cacheWriteUsdPerMillion": 13.75,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "us.anthropic.claude-fable-5-1": {
      "inputUsdPerMillion": 11,
      "outputUsdPerMillion": 55,
      "cacheReadUsdPerMillion": 0.275,
      "cacheWriteUsdPerMillion": 13.75,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "eu.anthropic.claude-fable-5": {
      "inputUsdPerMillion": 11,
      "outputUsdPerMillion": 55,
      "cacheReadUsdPerMillion": 1.1,
      "cacheWriteUsdPerMillion": 13.75,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "eu.anthropic.claude-fable-5-1": {
      "inputUsdPerMillion": 11,
      "outputUsdPerMillion": 55,
      "cacheReadUsdPerMillion": 0.275,
      "cacheWriteUsdPerMillion": 13.75,
      "provider": "bedrock_converse"
    },
    "anthropic.claude-opus-5": {
      "inputUsdPerMillion": 5,
      "outputUsdPerMillion": 25,
      "cacheReadUsdPerMillion": 0.5,
      "cacheWriteUsdPerMillion": 6.25,
      "provider": "bedrock_converse",
      "sourceUrl": "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrockFoundationModels/current/index.json"
    },
    "anthropic.claude-opus-5-5": {
      "inputUsdPerMillion": 4,
      "outputUsdPerMillion": 20,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "cacheWriteUsdPerMillion": 5,
      "provider": "bedrock_converse",
      "sourceUrl": "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrockFoundationModels/current/index.json"
    },
    "global.anthropic.claude-opus-5": {
      "inputUsdPerMillion": 5,
      "outputUsdPerMillion": 25,
      "cacheReadUsdPerMillion": 0.5,
      "cacheWriteUsdPerMillion": 6.25,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "global.anthropic.claude-opus-5-5": {
      "inputUsdPerMillion": 4,
      "outputUsdPerMillion": 20,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "cacheWriteUsdPerMillion": 5,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "us.anthropic.claude-opus-5": {
      "inputUsdPerMillion": 5.5,
      "outputUsdPerMillion": 27.5,
      "cacheReadUsdPerMillion": 0.55,
      "cacheWriteUsdPerMillion": 6.875,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "us.anthropic.claude-opus-5-5": {
      "inputUsdPerMillion": 4.4,
      "outputUsdPerMillion": 22,
      "cacheReadUsdPerMillion": 0.22,
      "cacheWriteUsdPerMillion": 5.5,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "eu.anthropic.claude-opus-5": {
      "inputUsdPerMillion": 5.5,
      "outputUsdPerMillion": 27.5,
      "cacheReadUsdPerMillion": 0.55,
      "cacheWriteUsdPerMillion": 6.875,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "eu.anthropic.claude-opus-5-5": {
      "inputUsdPerMillion": 4.4,
      "outputUsdPerMillion": 22,
      "cacheReadUsdPerMillion": 0.22,
      "cacheWriteUsdPerMillion": 5.5,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "au.anthropic.claude-opus-5": {
      "inputUsdPerMillion": 5.5,
      "outputUsdPerMillion": 27.5,
      "cacheReadUsdPerMillion": 0.55,
      "cacheWriteUsdPerMillion": 6.875,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "au.anthropic.claude-opus-5-5": {
      "inputUsdPerMillion": 4.4,
      "outputUsdPerMillion": 22,
      "cacheReadUsdPerMillion": 0.22,
      "cacheWriteUsdPerMillion": 5.5,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "jp.anthropic.claude-opus-5": {
      "inputUsdPerMillion": 5.5,
      "outputUsdPerMillion": 27.5,
      "cacheReadUsdPerMillion": 0.55,
      "cacheWriteUsdPerMillion": 6.875,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "jp.anthropic.claude-opus-5-5": {
      "inputUsdPerMillion": 4.4,
      "outputUsdPerMillion": 22,
      "cacheReadUsdPerMillion": 0.22,
      "cacheWriteUsdPerMillion": 5.5,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "anthropic.claude-opus-4-8": {
      "inputUsdPerMillion": 5,
      "outputUsdPerMillion": 25,
      "cacheReadUsdPerMillion": 0.5,
      "cacheWriteUsdPerMillion": 6.25,
      "provider": "bedrock_converse",
      "sourceUrl": "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrockFoundationModels/current/index.json"
    },
    "global.anthropic.claude-opus-4-8": {
      "inputUsdPerMillion": 5,
      "outputUsdPerMillion": 25,
      "cacheReadUsdPerMillion": 0.5,
      "cacheWriteUsdPerMillion": 6.25,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "us.anthropic.claude-opus-4-8": {
      "inputUsdPerMillion": 5.5,
      "outputUsdPerMillion": 27.5,
      "cacheReadUsdPerMillion": 0.55,
      "cacheWriteUsdPerMillion": 6.875,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "eu.anthropic.claude-opus-4-8": {
      "inputUsdPerMillion": 5.5,
      "outputUsdPerMillion": 27.5,
      "cacheReadUsdPerMillion": 0.55,
      "cacheWriteUsdPerMillion": 6.875,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "au.anthropic.claude-opus-4-8": {
      "inputUsdPerMillion": 5.5,
      "outputUsdPerMillion": 27.5,
      "cacheReadUsdPerMillion": 0.55,
      "cacheWriteUsdPerMillion": 6.875,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "jp.anthropic.claude-opus-4-8": {
      "inputUsdPerMillion": 5.5,
      "outputUsdPerMillion": 27.5,
      "cacheReadUsdPerMillion": 0.55,
      "cacheWriteUsdPerMillion": 6.875,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "jp.anthropic.claude-opus-4-7": {
      "inputUsdPerMillion": 5.5,
      "outputUsdPerMillion": 27.5,
      "cacheReadUsdPerMillion": 0.55,
      "cacheWriteUsdPerMillion": 6.875,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "anthropic.claude-sonnet-5": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 10,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "cacheWriteUsdPerMillion": 2.5,
      "provider": "bedrock_converse",
      "sourceUrl": "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrockFoundationModels/current/index.json"
    },
    "global.anthropic.claude-sonnet-5": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 10,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "cacheWriteUsdPerMillion": 2.5,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "us.anthropic.claude-sonnet-5": {
      "inputUsdPerMillion": 2.2,
      "outputUsdPerMillion": 11,
      "cacheReadUsdPerMillion": 0.22,
      "cacheWriteUsdPerMillion": 2.75,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "eu.anthropic.claude-sonnet-5": {
      "inputUsdPerMillion": 2.2,
      "outputUsdPerMillion": 11,
      "cacheReadUsdPerMillion": 0.22,
      "cacheWriteUsdPerMillion": 2.75,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "au.anthropic.claude-sonnet-5": {
      "inputUsdPerMillion": 2.2,
      "outputUsdPerMillion": 11,
      "cacheReadUsdPerMillion": 0.22,
      "cacheWriteUsdPerMillion": 2.75,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "jp.anthropic.claude-sonnet-5": {
      "inputUsdPerMillion": 2.2,
      "outputUsdPerMillion": 11,
      "cacheReadUsdPerMillion": 0.22,
      "cacheWriteUsdPerMillion": 2.75,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "anthropic.claude-sonnet-4-6": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 15,
      "cacheReadUsdPerMillion": 0.3,
      "cacheWriteUsdPerMillion": 3.75,
      "provider": "bedrock_converse",
      "sourceUrl": "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrockFoundationModels/current/index.json"
    },
    "global.anthropic.claude-sonnet-4-6": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 15,
      "cacheReadUsdPerMillion": 0.3,
      "cacheWriteUsdPerMillion": 3.75,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "us.anthropic.claude-sonnet-4-6": {
      "inputUsdPerMillion": 3.3000000000000003,
      "outputUsdPerMillion": 16.5,
      "cacheReadUsdPerMillion": 0.33,
      "cacheWriteUsdPerMillion": 4.125,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "eu.anthropic.claude-sonnet-4-6": {
      "inputUsdPerMillion": 3.3000000000000003,
      "outputUsdPerMillion": 16.5,
      "cacheReadUsdPerMillion": 0.33,
      "cacheWriteUsdPerMillion": 4.125,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "au.anthropic.claude-sonnet-4-6": {
      "inputUsdPerMillion": 3.3000000000000003,
      "outputUsdPerMillion": 16.5,
      "cacheReadUsdPerMillion": 0.33,
      "cacheWriteUsdPerMillion": 4.125,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "jp.anthropic.claude-sonnet-4-6": {
      "inputUsdPerMillion": 3.3000000000000003,
      "outputUsdPerMillion": 16.5,
      "cacheReadUsdPerMillion": 0.33,
      "cacheWriteUsdPerMillion": 4.125,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "anthropic.claude-sonnet-4-20250514-v1:0": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 15,
      "cacheReadUsdPerMillion": 0.3,
      "cacheWriteUsdPerMillion": 3.75,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "anthropic.claude-sonnet-4-5-20250929-v1:0": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 15,
      "cacheReadUsdPerMillion": 0.3,
      "cacheWriteUsdPerMillion": 3.75,
      "provider": "bedrock_converse",
      "sourceUrl": "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrockFoundationModels/current/index.json"
    },
    "anthropic.claude-v1": {
      "inputUsdPerMillion": 8,
      "outputUsdPerMillion": 24,
      "provider": "bedrock"
    },
    "anthropic.claude-v2:1": {
      "inputUsdPerMillion": 8,
      "outputUsdPerMillion": 24,
      "provider": "bedrock"
    },
    "anyscale/HuggingFaceH4/zephyr-7b-beta": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.15,
      "provider": "anyscale"
    },
    "anyscale/codellama/CodeLlama-34b-Instruct-hf": {
      "inputUsdPerMillion": 1,
      "outputUsdPerMillion": 1,
      "provider": "anyscale"
    },
    "anyscale/codellama/CodeLlama-70b-Instruct-hf": {
      "inputUsdPerMillion": 1,
      "outputUsdPerMillion": 1,
      "provider": "anyscale",
      "sourceUrl": "https://docs.anyscale.com/preview/endpoints/text-generation/supported-models/codellama-CodeLlama-70b-Instruct-hf"
    },
    "anyscale/google/gemma-7b-it": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.15,
      "provider": "anyscale",
      "sourceUrl": "https://docs.anyscale.com/preview/endpoints/text-generation/supported-models/google-gemma-7b-it"
    },
    "anyscale/meta-llama/Llama-2-13b-chat-hf": {
      "inputUsdPerMillion": 0.25,
      "outputUsdPerMillion": 0.25,
      "provider": "anyscale"
    },
    "anyscale/meta-llama/Llama-2-70b-chat-hf": {
      "inputUsdPerMillion": 1,
      "outputUsdPerMillion": 1,
      "provider": "anyscale"
    },
    "anyscale/meta-llama/Llama-2-7b-chat-hf": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.15,
      "provider": "anyscale"
    },
    "anyscale/meta-llama/Meta-Llama-3-70B-Instruct": {
      "inputUsdPerMillion": 1,
      "outputUsdPerMillion": 1,
      "provider": "anyscale",
      "sourceUrl": "https://docs.anyscale.com/preview/endpoints/text-generation/supported-models/meta-llama-Meta-Llama-3-70B-Instruct"
    },
    "anyscale/meta-llama/Meta-Llama-3-8B-Instruct": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.15,
      "provider": "anyscale",
      "sourceUrl": "https://docs.anyscale.com/preview/endpoints/text-generation/supported-models/meta-llama-Meta-Llama-3-8B-Instruct"
    },
    "anyscale/mistralai/Mistral-7B-Instruct-v0.1": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.15,
      "provider": "anyscale",
      "sourceUrl": "https://docs.anyscale.com/preview/endpoints/text-generation/supported-models/mistralai-Mistral-7B-Instruct-v0.1"
    },
    "anyscale/mistralai/Mixtral-8x22B-Instruct-v0.1": {
      "inputUsdPerMillion": 0.8999999999999999,
      "outputUsdPerMillion": 0.8999999999999999,
      "provider": "anyscale",
      "sourceUrl": "https://docs.anyscale.com/preview/endpoints/text-generation/supported-models/mistralai-Mixtral-8x22B-Instruct-v0.1"
    },
    "anyscale/mistralai/Mixtral-8x7B-Instruct-v0.1": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.15,
      "provider": "anyscale",
      "sourceUrl": "https://docs.anyscale.com/preview/endpoints/text-generation/supported-models/mistralai-Mixtral-8x7B-Instruct-v0.1"
    },
    "apac.amazon.nova-lite-v1:0": {
      "inputUsdPerMillion": 0.063,
      "outputUsdPerMillion": 0.252,
      "cacheReadUsdPerMillion": 0.01575,
      "provider": "bedrock_converse"
    },
    "apac.amazon.nova-micro-v1:0": {
      "inputUsdPerMillion": 0.037,
      "outputUsdPerMillion": 0.148,
      "cacheReadUsdPerMillion": 0.00925,
      "provider": "bedrock_converse"
    },
    "apac.amazon.nova-pro-v1:0": {
      "inputUsdPerMillion": 0.84,
      "outputUsdPerMillion": 3.36,
      "cacheReadUsdPerMillion": 0.21,
      "provider": "bedrock_converse"
    },
    "apac.anthropic.claude-haiku-4-5-20251001-v1:0": {
      "inputUsdPerMillion": 1.1,
      "outputUsdPerMillion": 5.5,
      "cacheReadUsdPerMillion": 0.11,
      "cacheWriteUsdPerMillion": 1.375,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/about-aws/whats-new/2025/10/claude-4-5-haiku-anthropic-amazon-bedrock"
    },
    "apac.anthropic.claude-sonnet-4-20250514-v1:0": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 15,
      "cacheReadUsdPerMillion": 0.3,
      "cacheWriteUsdPerMillion": 3.75,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "au.anthropic.claude-sonnet-4-5-20250929-v1:0": {
      "inputUsdPerMillion": 3.3000000000000003,
      "outputUsdPerMillion": 16.5,
      "cacheReadUsdPerMillion": 0.33,
      "cacheWriteUsdPerMillion": 4.125,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "azure/command-r-plus": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 15,
      "provider": "azure",
      "sourceUrl": "https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/retired-models"
    },
    "azure_ai/claude-haiku-4-5": {
      "inputUsdPerMillion": 1,
      "outputUsdPerMillion": 5,
      "cacheReadUsdPerMillion": 0.09999999999999999,
      "cacheWriteUsdPerMillion": 1.25,
      "provider": "azure_ai",
      "sourceUrl": "https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/model-retirement-schedule"
    },
    "azure_ai/claude-opus-4-5": {
      "inputUsdPerMillion": 5,
      "outputUsdPerMillion": 25,
      "cacheReadUsdPerMillion": 0.5,
      "cacheWriteUsdPerMillion": 6.25,
      "provider": "azure_ai",
      "sourceUrl": "https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/model-retirement-schedule"
    },
    "azure_ai/claude-opus-4-6": {
      "inputUsdPerMillion": 5,
      "outputUsdPerMillion": 25,
      "cacheReadUsdPerMillion": 0.5,
      "cacheWriteUsdPerMillion": 6.25,
      "provider": "azure_ai"
    },
    "azure_ai/claude-opus-4-7": {
      "inputUsdPerMillion": 5,
      "outputUsdPerMillion": 25,
      "cacheReadUsdPerMillion": 0.5,
      "cacheWriteUsdPerMillion": 6.25,
      "provider": "azure_ai"
    },
    "azure_ai/claude-fable-5": {
      "inputUsdPerMillion": 10,
      "outputUsdPerMillion": 50,
      "cacheReadUsdPerMillion": 1,
      "cacheWriteUsdPerMillion": 12.5,
      "provider": "azure_ai"
    },
    "azure_ai/claude-fable-5-1": {
      "inputUsdPerMillion": 10,
      "outputUsdPerMillion": 50,
      "cacheReadUsdPerMillion": 0.25,
      "cacheWriteUsdPerMillion": 12.5,
      "provider": "azure_ai"
    },
    "azure_ai/claude-opus-5": {
      "inputUsdPerMillion": 5,
      "outputUsdPerMillion": 25,
      "cacheReadUsdPerMillion": 0.5,
      "cacheWriteUsdPerMillion": 6.25,
      "provider": "azure_ai"
    },
    "azure_ai/claude-opus-5-5": {
      "inputUsdPerMillion": 4,
      "outputUsdPerMillion": 20,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "cacheWriteUsdPerMillion": 5,
      "provider": "azure_ai",
      "sourceUrl": "https://management.azure.com/subscriptions/c873328e-b572-4770-8dff-aaeb6f1f0e79/providers/Microsoft.CognitiveServices/locations/eastus2/models?api-version=2024-10-01"
    },
    "azure_ai/claude-opus-4-8": {
      "inputUsdPerMillion": 5,
      "outputUsdPerMillion": 25,
      "cacheReadUsdPerMillion": 0.5,
      "cacheWriteUsdPerMillion": 6.25,
      "provider": "azure_ai"
    },
    "azure_ai/claude-sonnet-4-5": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 15,
      "cacheReadUsdPerMillion": 0.3,
      "cacheWriteUsdPerMillion": 3.75,
      "provider": "azure_ai",
      "sourceUrl": "https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/model-retirement-schedule"
    },
    "azure_ai/claude-sonnet-5": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 10,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "cacheWriteUsdPerMillion": 2.5,
      "provider": "azure_ai"
    },
    "azure_ai/claude-sonnet-4-6": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 15,
      "cacheReadUsdPerMillion": 0.3,
      "cacheWriteUsdPerMillion": 3.75,
      "provider": "azure_ai",
      "sourceUrl": "https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/claude-models"
    },
    "azure/computer-use-preview": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 12,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure_ai/gpt-oss-120b": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.6,
      "provider": "azure_ai",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure_ai/gpt-6-astra": {
      "inputUsdPerMillion": 10,
      "outputUsdPerMillion": 50,
      "cacheReadUsdPerMillion": 1,
      "cacheWriteUsdPerMillion": 12.5,
      "provider": "azure_ai",
      "sourceUrl": "https://ai.azure.com/catalog/models/gpt-6-astra"
    },
    "azure_ai/gpt-6-luna": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.5,
      "cacheReadUsdPerMillion": 0.01,
      "cacheWriteUsdPerMillion": 0.125,
      "provider": "azure_ai",
      "sourceUrl": "https://azure.microsoft.com/en-us/blog/gpt-6-astra-sol-and-luna-for-production-agents-in-microsoft-foundry/"
    },
    "azure_ai/gpt-6-sol": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 10,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "cacheWriteUsdPerMillion": 2.5,
      "provider": "azure_ai",
      "sourceUrl": "https://azure.microsoft.com/en-us/blog/gpt-6-astra-sol-and-luna-for-production-agents-in-microsoft-foundry/"
    },
    "azure_ai/gpt-6.1-sol": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 10,
      "cacheReadUsdPerMillion": 0.09999999999999999,
      "cacheWriteUsdPerMillion": 2.5,
      "provider": "azure_ai",
      "sourceUrl": "https://learn.microsoft.com/en-us/azure/ai-foundry/openai/concepts/models"
    },
    "azure_ai/gpt-5.5": {
      "inputUsdPerMillion": 5,
      "outputUsdPerMillion": 30,
      "cacheReadUsdPerMillion": 0.5,
      "provider": "azure_ai",
      "sourceUrl": "https://ai.azure.com/catalog/models/gpt-5.5"
    },
    "azure_ai/gpt-chat-latest": {
      "inputUsdPerMillion": 5,
      "outputUsdPerMillion": 30,
      "cacheReadUsdPerMillion": 0.5,
      "provider": "azure_ai",
      "sourceUrl": "https://azure.microsoft.com/en-us/pricing/details/cognitive-services/openai-service/"
    },
    "azure_ai/gpt-5.5-2026-04-23": {
      "inputUsdPerMillion": 5,
      "outputUsdPerMillion": 30,
      "cacheReadUsdPerMillion": 0.5,
      "provider": "azure_ai",
      "sourceUrl": "https://ai.azure.com/catalog/models/gpt-5.5"
    },
    "azure_ai/gpt-5.5-2026-04-24": {
      "inputUsdPerMillion": 5,
      "outputUsdPerMillion": 30,
      "cacheReadUsdPerMillion": 0.5,
      "provider": "azure_ai",
      "sourceUrl": "https://learn.microsoft.com/en-us/azure/ai-foundry/openai/concepts/models"
    },
    "azure_ai/gpt-5.4": {
      "inputUsdPerMillion": 2.5,
      "outputUsdPerMillion": 15,
      "cacheReadUsdPerMillion": 0.25,
      "provider": "azure_ai",
      "sourceUrl": "https://ai.azure.com/catalog/models/gpt-5.4"
    },
    "azure_ai/gpt-5.4-2026-03-05": {
      "inputUsdPerMillion": 2.5,
      "outputUsdPerMillion": 15,
      "cacheReadUsdPerMillion": 0.25,
      "provider": "azure_ai",
      "sourceUrl": "https://ai.azure.com/catalog/models/gpt-5.4"
    },
    "azure_ai/gpt-5.4-mini": {
      "inputUsdPerMillion": 0.75,
      "outputUsdPerMillion": 4.5,
      "cacheReadUsdPerMillion": 0.075,
      "provider": "azure_ai",
      "sourceUrl": "https://ai.azure.com/catalog/models/gpt-5.4-mini"
    },
    "azure_ai/gpt-5.4-mini-2026-03-17": {
      "inputUsdPerMillion": 0.75,
      "outputUsdPerMillion": 4.5,
      "cacheReadUsdPerMillion": 0.075,
      "provider": "azure_ai",
      "sourceUrl": "https://ai.azure.com/catalog/models/gpt-5.4-mini"
    },
    "azure_ai/gpt-5.4-nano": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 1.25,
      "cacheReadUsdPerMillion": 0.02,
      "provider": "azure_ai",
      "sourceUrl": "https://ai.azure.com/catalog/models/gpt-5.4-nano"
    },
    "azure_ai/gpt-5.4-nano-2026-03-17": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 1.25,
      "cacheReadUsdPerMillion": 0.02,
      "provider": "azure_ai",
      "sourceUrl": "https://ai.azure.com/catalog/models/gpt-5.4-nano"
    },
    "azure_ai/model_router": {
      "inputUsdPerMillion": 0.14,
      "outputUsdPerMillion": 0,
      "provider": "azure_ai",
      "sourceUrl": "https://azure.microsoft.com/en-us/pricing/details/ai-foundry-models/aoai/"
    },
    "azure_ai/model-router": {
      "inputUsdPerMillion": 0.14,
      "outputUsdPerMillion": 0,
      "provider": "azure_ai",
      "sourceUrl": "https://azure.microsoft.com/en-us/pricing/details/ai-foundry-models/aoai/"
    },
    "azure/eu/gpt-4o-2024-08-06": {
      "inputUsdPerMillion": 2.75,
      "outputUsdPerMillion": 11,
      "cacheReadUsdPerMillion": 1.375,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/eu/gpt-4o-2024-11-20": {
      "inputUsdPerMillion": 2.75,
      "outputUsdPerMillion": 11,
      "cacheReadUsdPerMillion": 1.375,
      "cacheWriteUsdPerMillion": 1.38,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/eu/gpt-4o-mini-2024-07-18": {
      "inputUsdPerMillion": 0.165,
      "outputUsdPerMillion": 0.66,
      "cacheReadUsdPerMillion": 0.083,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/eu/gpt-5-2025-08-07": {
      "inputUsdPerMillion": 1.375,
      "outputUsdPerMillion": 11,
      "cacheReadUsdPerMillion": 0.1375,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/eu/gpt-5-mini-2025-08-07": {
      "inputUsdPerMillion": 0.275,
      "outputUsdPerMillion": 2.2,
      "cacheReadUsdPerMillion": 0.0275,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/eu/gpt-5.1": {
      "inputUsdPerMillion": 1.375,
      "outputUsdPerMillion": 11,
      "cacheReadUsdPerMillion": 0.1375,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/eu/gpt-5-nano-2025-08-07": {
      "inputUsdPerMillion": 0.055,
      "outputUsdPerMillion": 0.44,
      "cacheReadUsdPerMillion": 0.0055,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/eu/o1-2024-12-17": {
      "inputUsdPerMillion": 16.5,
      "outputUsdPerMillion": 66,
      "cacheReadUsdPerMillion": 8.25,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/eu/o1-mini-2024-09-12": {
      "inputUsdPerMillion": 1.21,
      "outputUsdPerMillion": 4.84,
      "cacheReadUsdPerMillion": 0.605,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/eu/o3-mini-2025-01-31": {
      "inputUsdPerMillion": 1.21,
      "outputUsdPerMillion": 4.84,
      "cacheReadUsdPerMillion": 0.605,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/global-standard/gpt-4o-2024-08-06": {
      "inputUsdPerMillion": 2.5,
      "outputUsdPerMillion": 10,
      "cacheReadUsdPerMillion": 1.25,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/global-standard/gpt-4o-2024-11-20": {
      "inputUsdPerMillion": 2.5,
      "outputUsdPerMillion": 10,
      "cacheReadUsdPerMillion": 1.25,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/global-standard/gpt-4o-mini": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.6,
      "provider": "azure"
    },
    "azure/global/gpt-4o-2024-08-06": {
      "inputUsdPerMillion": 2.5,
      "outputUsdPerMillion": 10,
      "cacheReadUsdPerMillion": 1.25,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/global/gpt-4o-2024-11-20": {
      "inputUsdPerMillion": 2.5,
      "outputUsdPerMillion": 10,
      "cacheReadUsdPerMillion": 1.25,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/global/gpt-5.1": {
      "inputUsdPerMillion": 1.25,
      "outputUsdPerMillion": 10,
      "cacheReadUsdPerMillion": 0.125,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/gpt-3.5-turbo": {
      "inputUsdPerMillion": 0.5,
      "outputUsdPerMillion": 1.5,
      "provider": "azure"
    },
    "azure/gpt-3.5-turbo-instruct-0914": {
      "inputUsdPerMillion": 1.5,
      "outputUsdPerMillion": 2,
      "provider": "azure_text"
    },
    "azure/gpt-35-turbo": {
      "inputUsdPerMillion": 0.5,
      "outputUsdPerMillion": 1.5,
      "provider": "azure"
    },
    "azure/gpt-35-turbo-16k": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 4,
      "provider": "azure",
      "sourceUrl": "https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/legacy-models"
    },
    "azure/gpt-35-turbo-16k-0613": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 4,
      "provider": "azure",
      "sourceUrl": "https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/legacy-models"
    },
    "azure/gpt-35-turbo-instruct": {
      "inputUsdPerMillion": 1.5,
      "outputUsdPerMillion": 2,
      "provider": "azure_text"
    },
    "azure/gpt-35-turbo-instruct-0914": {
      "inputUsdPerMillion": 1.5,
      "outputUsdPerMillion": 2,
      "provider": "azure_text"
    },
    "azure/gpt-4": {
      "inputUsdPerMillion": 30,
      "outputUsdPerMillion": 60,
      "provider": "azure",
      "sourceUrl": "https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/retired-models"
    },
    "azure/gpt-4-0125-preview": {
      "inputUsdPerMillion": 10,
      "outputUsdPerMillion": 30,
      "provider": "azure"
    },
    "azure/gpt-4-0613": {
      "inputUsdPerMillion": 30,
      "outputUsdPerMillion": 60,
      "provider": "azure",
      "sourceUrl": "https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/legacy-models"
    },
    "azure/gpt-4-1106-preview": {
      "inputUsdPerMillion": 10,
      "outputUsdPerMillion": 30,
      "provider": "azure"
    },
    "azure/gpt-4-32k": {
      "inputUsdPerMillion": 60,
      "outputUsdPerMillion": 120,
      "provider": "azure",
      "sourceUrl": "https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/legacy-models"
    },
    "azure/gpt-4-32k-0613": {
      "inputUsdPerMillion": 60,
      "outputUsdPerMillion": 120,
      "provider": "azure",
      "sourceUrl": "https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/legacy-models"
    },
    "azure/gpt-4-turbo": {
      "inputUsdPerMillion": 10,
      "outputUsdPerMillion": 30,
      "provider": "azure"
    },
    "azure/gpt-4-turbo-2024-04-09": {
      "inputUsdPerMillion": 10,
      "outputUsdPerMillion": 30,
      "provider": "azure"
    },
    "azure/gpt-4-turbo-vision-preview": {
      "inputUsdPerMillion": 10,
      "outputUsdPerMillion": 30,
      "provider": "azure"
    },
    "azure/gpt-4.1": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 8,
      "cacheReadUsdPerMillion": 0.5,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/gpt-4.1-2025-04-14": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 8,
      "cacheReadUsdPerMillion": 0.5,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/gpt-4.1-mini": {
      "inputUsdPerMillion": 0.39999999999999997,
      "outputUsdPerMillion": 1.5999999999999999,
      "cacheReadUsdPerMillion": 0.09999999999999999,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/gpt-4.1-mini-2025-04-14": {
      "inputUsdPerMillion": 0.39999999999999997,
      "outputUsdPerMillion": 1.5999999999999999,
      "cacheReadUsdPerMillion": 0.09999999999999999,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/gpt-4.1-nano": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.39999999999999997,
      "cacheReadUsdPerMillion": 0.024999999999999998,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/gpt-4.1-nano-2025-04-14": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.39999999999999997,
      "cacheReadUsdPerMillion": 0.024999999999999998,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/gpt-4.5-preview": {
      "inputUsdPerMillion": 75,
      "outputUsdPerMillion": 150,
      "cacheReadUsdPerMillion": 37.5,
      "provider": "azure",
      "sourceUrl": "https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/legacy-models"
    },
    "azure/gpt-4o": {
      "inputUsdPerMillion": 2.5,
      "outputUsdPerMillion": 10,
      "cacheReadUsdPerMillion": 1.25,
      "provider": "azure"
    },
    "azure/gpt-4o-2024-05-13": {
      "inputUsdPerMillion": 5,
      "outputUsdPerMillion": 15,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/gpt-4o-2024-08-06": {
      "inputUsdPerMillion": 2.5,
      "outputUsdPerMillion": 10,
      "cacheReadUsdPerMillion": 1.25,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/gpt-4o-2024-11-20": {
      "inputUsdPerMillion": 2.5,
      "outputUsdPerMillion": 10,
      "cacheReadUsdPerMillion": 1.25,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/gpt-audio": {
      "inputUsdPerMillion": 2.5,
      "outputUsdPerMillion": 10,
      "provider": "azure",
      "sourceUrl": "https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/models-sold-directly-by-azure"
    },
    "azure/gpt-audio-2025-08-28": {
      "inputUsdPerMillion": 2.5,
      "outputUsdPerMillion": 10,
      "provider": "azure"
    },
    "azure/gpt-audio-1.5": {
      "inputUsdPerMillion": 2.5,
      "outputUsdPerMillion": 10,
      "provider": "azure",
      "sourceUrl": "https://azure.microsoft.com/en-us/pricing/details/azure-openai/"
    },
    "azure/gpt-audio-1.5-2026-02-23": {
      "inputUsdPerMillion": 2.5,
      "outputUsdPerMillion": 10,
      "provider": "azure",
      "sourceUrl": "https://azure.microsoft.com/en-us/pricing/details/azure-openai/"
    },
    "azure/gpt-audio-mini": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 2.4,
      "provider": "azure"
    },
    "azure/gpt-audio-mini-2025-10-06": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 2.4,
      "provider": "azure"
    },
    "azure/gpt-4o-audio-preview-2024-12-17": {
      "inputUsdPerMillion": 2.5,
      "outputUsdPerMillion": 10,
      "provider": "azure"
    },
    "azure/gpt-4o-mini": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.6,
      "cacheReadUsdPerMillion": 0.075,
      "provider": "azure"
    },
    "azure/gpt-4o-mini-2024-07-18": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.6,
      "cacheReadUsdPerMillion": 0.075,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/gpt-4o-mini-audio-preview-2024-12-17": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.6,
      "provider": "azure",
      "sourceUrl": "https://azure.microsoft.com/en-us/pricing/details/azure-openai/"
    },
    "azure/gpt-5.1-2025-11-13": {
      "inputUsdPerMillion": 1.25,
      "outputUsdPerMillion": 10,
      "cacheReadUsdPerMillion": 0.125,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/gpt-5": {
      "inputUsdPerMillion": 1.25,
      "outputUsdPerMillion": 10,
      "cacheReadUsdPerMillion": 0.125,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/gpt-5-2025-08-07": {
      "inputUsdPerMillion": 1.25,
      "outputUsdPerMillion": 10,
      "cacheReadUsdPerMillion": 0.125,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/gpt-5-mini": {
      "inputUsdPerMillion": 0.25,
      "outputUsdPerMillion": 2,
      "cacheReadUsdPerMillion": 0.024999999999999998,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/gpt-5-mini-2025-08-07": {
      "inputUsdPerMillion": 0.25,
      "outputUsdPerMillion": 2,
      "cacheReadUsdPerMillion": 0.024999999999999998,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/gpt-5-nano": {
      "inputUsdPerMillion": 0.049999999999999996,
      "outputUsdPerMillion": 0.39999999999999997,
      "cacheReadUsdPerMillion": 0.005,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/gpt-5-nano-2025-08-07": {
      "inputUsdPerMillion": 0.049999999999999996,
      "outputUsdPerMillion": 0.39999999999999997,
      "cacheReadUsdPerMillion": 0.005,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/gpt-5.1": {
      "inputUsdPerMillion": 1.25,
      "outputUsdPerMillion": 10,
      "cacheReadUsdPerMillion": 0.125,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/gpt-5-chat": {
      "inputUsdPerMillion": 1.25,
      "outputUsdPerMillion": 10,
      "cacheReadUsdPerMillion": 0.125,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/gpt-5.1-chat": {
      "inputUsdPerMillion": 1.25,
      "outputUsdPerMillion": 10,
      "cacheReadUsdPerMillion": 0.125,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/gpt-5.2-chat": {
      "inputUsdPerMillion": 1.75,
      "outputUsdPerMillion": 14,
      "cacheReadUsdPerMillion": 0.175,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/gpt-5.3-chat": {
      "inputUsdPerMillion": 1.75,
      "outputUsdPerMillion": 14,
      "cacheReadUsdPerMillion": 0.175,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/us/gpt-5.1-chat": {
      "inputUsdPerMillion": 1.375,
      "outputUsdPerMillion": 11,
      "cacheReadUsdPerMillion": 0.1375,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/us/gpt-5.2-chat": {
      "inputUsdPerMillion": 1.9250000000000003,
      "outputUsdPerMillion": 15.400000000000002,
      "cacheReadUsdPerMillion": 0.1925,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/us/gpt-5.3-chat": {
      "inputUsdPerMillion": 1.9250000000000003,
      "outputUsdPerMillion": 15.400000000000002,
      "cacheReadUsdPerMillion": 0.1925,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/eu/gpt-5.1-chat": {
      "inputUsdPerMillion": 1.375,
      "outputUsdPerMillion": 11,
      "cacheReadUsdPerMillion": 0.1375,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/eu/gpt-5.2-chat": {
      "inputUsdPerMillion": 1.9250000000000003,
      "outputUsdPerMillion": 15.400000000000002,
      "cacheReadUsdPerMillion": 0.1925,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/eu/gpt-5.3-chat": {
      "inputUsdPerMillion": 1.9250000000000003,
      "outputUsdPerMillion": 15.400000000000002,
      "cacheReadUsdPerMillion": 0.1925,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/us/o1-preview": {
      "inputUsdPerMillion": 16.5,
      "outputUsdPerMillion": 66,
      "cacheReadUsdPerMillion": 8.25,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/eu/o1-preview": {
      "inputUsdPerMillion": 16.5,
      "outputUsdPerMillion": 66,
      "cacheReadUsdPerMillion": 8.25,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/gpt-5.2": {
      "inputUsdPerMillion": 1.75,
      "outputUsdPerMillion": 14,
      "cacheReadUsdPerMillion": 0.175,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/gpt-5.2-2025-12-11": {
      "inputUsdPerMillion": 1.75,
      "outputUsdPerMillion": 14,
      "cacheReadUsdPerMillion": 0.175,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/gpt-5.4": {
      "inputUsdPerMillion": 2.5,
      "outputUsdPerMillion": 15,
      "cacheReadUsdPerMillion": 0.25,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/us/gpt-5.4": {
      "inputUsdPerMillion": 2.75,
      "outputUsdPerMillion": 16.5,
      "cacheReadUsdPerMillion": 0.275,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/eu/gpt-5.4": {
      "inputUsdPerMillion": 2.75,
      "outputUsdPerMillion": 16.5,
      "cacheReadUsdPerMillion": 0.275,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/gpt-5.4-2026-03-05": {
      "inputUsdPerMillion": 2.5,
      "outputUsdPerMillion": 15,
      "cacheReadUsdPerMillion": 0.25,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/us/gpt-5.4-2026-03-05": {
      "inputUsdPerMillion": 2.75,
      "outputUsdPerMillion": 16.5,
      "cacheReadUsdPerMillion": 0.275,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/eu/gpt-5.4-2026-03-05": {
      "inputUsdPerMillion": 2.75,
      "outputUsdPerMillion": 16.5,
      "cacheReadUsdPerMillion": 0.275,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/gpt-5.6": {
      "inputUsdPerMillion": 4,
      "outputUsdPerMillion": 20,
      "cacheReadUsdPerMillion": 0.39999999999999997,
      "cacheWriteUsdPerMillion": 5,
      "provider": "azure"
    },
    "azure/gpt-5.6-sol": {
      "inputUsdPerMillion": 4,
      "outputUsdPerMillion": 20,
      "cacheReadUsdPerMillion": 0.39999999999999997,
      "cacheWriteUsdPerMillion": 5,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/gpt-5.6-sol-2026-07-09": {
      "inputUsdPerMillion": 4,
      "outputUsdPerMillion": 20,
      "cacheReadUsdPerMillion": 0.39999999999999997,
      "cacheWriteUsdPerMillion": 5,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/gpt-5.6-terra": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 12,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "cacheWriteUsdPerMillion": 2.5,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/gpt-5.6-terra-2026-07-09": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 12,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "cacheWriteUsdPerMillion": 2.5,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/gpt-5.6-luna": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 1.2,
      "cacheReadUsdPerMillion": 0.02,
      "cacheWriteUsdPerMillion": 0.25,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/gpt-5.6-luna-2026-07-09": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 1.2,
      "cacheReadUsdPerMillion": 0.02,
      "cacheWriteUsdPerMillion": 0.25,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/gpt-6-astra": {
      "inputUsdPerMillion": 10,
      "outputUsdPerMillion": 50,
      "cacheReadUsdPerMillion": 1,
      "cacheWriteUsdPerMillion": 12.5,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/gpt-6-astra-2026-09-03": {
      "inputUsdPerMillion": 10,
      "outputUsdPerMillion": 50,
      "cacheReadUsdPerMillion": 1,
      "cacheWriteUsdPerMillion": 12.5,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/gpt-6-luna": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.5,
      "cacheReadUsdPerMillion": 0.01,
      "cacheWriteUsdPerMillion": 0.125,
      "provider": "azure",
      "sourceUrl": "https://azure.microsoft.com/en-us/blog/gpt-6-astra-sol-and-luna-for-production-agents-in-microsoft-foundry/"
    },
    "azure/gpt-6-luna-2026-09-22": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.5,
      "cacheReadUsdPerMillion": 0.01,
      "cacheWriteUsdPerMillion": 0.125,
      "provider": "azure",
      "sourceUrl": "https://azure.microsoft.com/en-us/blog/gpt-6-astra-sol-and-luna-for-production-agents-in-microsoft-foundry/"
    },
    "azure/gpt-6-sol": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 10,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "cacheWriteUsdPerMillion": 2.5,
      "provider": "azure",
      "sourceUrl": "https://azure.microsoft.com/en-us/blog/gpt-6-astra-sol-and-luna-for-production-agents-in-microsoft-foundry/"
    },
    "azure/gpt-6-sol-2026-09-22": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 10,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "cacheWriteUsdPerMillion": 2.5,
      "provider": "azure",
      "sourceUrl": "https://azure.microsoft.com/en-us/blog/gpt-6-astra-sol-and-luna-for-production-agents-in-microsoft-foundry/"
    },
    "azure/gpt-6.1-sol": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 10,
      "cacheReadUsdPerMillion": 0.09999999999999999,
      "cacheWriteUsdPerMillion": 2.5,
      "provider": "azure",
      "sourceUrl": "https://learn.microsoft.com/en-us/azure/ai-foundry/openai/concepts/models"
    },
    "azure/gpt-6.1-sol-2026-09-29": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 10,
      "cacheReadUsdPerMillion": 0.09999999999999999,
      "cacheWriteUsdPerMillion": 2.5,
      "provider": "azure",
      "sourceUrl": "https://learn.microsoft.com/en-us/azure/ai-foundry/openai/concepts/models"
    },
    "azure/us/gpt-6.1-sol": {
      "inputUsdPerMillion": 2.2,
      "outputUsdPerMillion": 11,
      "cacheReadUsdPerMillion": 0.11,
      "cacheWriteUsdPerMillion": 2.75,
      "provider": "azure",
      "sourceUrl": "https://learn.microsoft.com/en-us/azure/ai-foundry/openai/concepts/models"
    },
    "azure/eu/gpt-6.1-sol": {
      "inputUsdPerMillion": 2.4,
      "outputUsdPerMillion": 12,
      "cacheReadUsdPerMillion": 0.12,
      "cacheWriteUsdPerMillion": 3,
      "provider": "azure",
      "sourceUrl": "https://learn.microsoft.com/en-us/azure/ai-foundry/openai/concepts/models"
    },
    "azure/apac/gpt-6.1-sol": {
      "inputUsdPerMillion": 2.4,
      "outputUsdPerMillion": 12,
      "cacheReadUsdPerMillion": 0.12,
      "cacheWriteUsdPerMillion": 3,
      "provider": "azure",
      "sourceUrl": "https://learn.microsoft.com/en-us/azure/ai-foundry/openai/concepts/models"
    },
    "azure/gpt-chat-latest": {
      "inputUsdPerMillion": 5,
      "outputUsdPerMillion": 30,
      "cacheReadUsdPerMillion": 0.5,
      "provider": "azure",
      "sourceUrl": "https://azure.microsoft.com/en-us/pricing/details/cognitive-services/openai-service/"
    },
    "azure/chat-latest": {
      "inputUsdPerMillion": 5,
      "outputUsdPerMillion": 30,
      "cacheReadUsdPerMillion": 0.5,
      "provider": "azure",
      "sourceUrl": "https://azure.microsoft.com/en-us/pricing/details/cognitive-services/openai-service/"
    },
    "azure/us/gpt-5.6": {
      "inputUsdPerMillion": 4.4,
      "outputUsdPerMillion": 22,
      "cacheReadUsdPerMillion": 0.44,
      "cacheWriteUsdPerMillion": 5.5,
      "provider": "azure"
    },
    "azure/us/gpt-5.6-sol": {
      "inputUsdPerMillion": 4.4,
      "outputUsdPerMillion": 22,
      "cacheReadUsdPerMillion": 0.44,
      "cacheWriteUsdPerMillion": 5.5,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/us/gpt-5.6-terra": {
      "inputUsdPerMillion": 2.2,
      "outputUsdPerMillion": 13.200000000000001,
      "cacheReadUsdPerMillion": 0.22,
      "cacheWriteUsdPerMillion": 2.75,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/us/gpt-5.6-luna": {
      "inputUsdPerMillion": 0.22,
      "outputUsdPerMillion": 1.32,
      "cacheReadUsdPerMillion": 0.022,
      "cacheWriteUsdPerMillion": 0.275,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/us/gpt-6-astra": {
      "inputUsdPerMillion": 11,
      "outputUsdPerMillion": 55,
      "cacheReadUsdPerMillion": 1.1,
      "cacheWriteUsdPerMillion": 13.75,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/us/gpt-6-luna": {
      "inputUsdPerMillion": 0.11,
      "outputUsdPerMillion": 0.55,
      "cacheReadUsdPerMillion": 0.011,
      "cacheWriteUsdPerMillion": 0.1375,
      "provider": "azure",
      "sourceUrl": "https://azure.microsoft.com/en-us/blog/gpt-6-astra-sol-and-luna-for-production-agents-in-microsoft-foundry/"
    },
    "azure/us/gpt-6-sol": {
      "inputUsdPerMillion": 2.2,
      "outputUsdPerMillion": 11,
      "cacheReadUsdPerMillion": 0.22,
      "cacheWriteUsdPerMillion": 2.75,
      "provider": "azure",
      "sourceUrl": "https://azure.microsoft.com/en-us/blog/gpt-6-astra-sol-and-luna-for-production-agents-in-microsoft-foundry/"
    },
    "azure/us/gpt-chat-latest": {
      "inputUsdPerMillion": 5.5,
      "outputUsdPerMillion": 33,
      "cacheReadUsdPerMillion": 0.55,
      "provider": "azure",
      "sourceUrl": "https://azure.microsoft.com/en-us/pricing/details/cognitive-services/openai-service/"
    },
    "azure/eu/gpt-5.6": {
      "inputUsdPerMillion": 4.4,
      "outputUsdPerMillion": 22,
      "cacheReadUsdPerMillion": 0.44,
      "cacheWriteUsdPerMillion": 5.5,
      "provider": "azure"
    },
    "azure/eu/gpt-5.6-sol": {
      "inputUsdPerMillion": 4.4,
      "outputUsdPerMillion": 22,
      "cacheReadUsdPerMillion": 0.44,
      "cacheWriteUsdPerMillion": 5.5,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/eu/gpt-5.6-terra": {
      "inputUsdPerMillion": 2.2,
      "outputUsdPerMillion": 13.200000000000001,
      "cacheReadUsdPerMillion": 0.22,
      "cacheWriteUsdPerMillion": 2.75,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/eu/gpt-5.6-luna": {
      "inputUsdPerMillion": 0.22,
      "outputUsdPerMillion": 1.32,
      "cacheReadUsdPerMillion": 0.022,
      "cacheWriteUsdPerMillion": 0.275,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/gpt-5.5": {
      "inputUsdPerMillion": 5,
      "outputUsdPerMillion": 30,
      "cacheReadUsdPerMillion": 0.5,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/us/gpt-5.5": {
      "inputUsdPerMillion": 5.5,
      "outputUsdPerMillion": 33,
      "cacheReadUsdPerMillion": 0.55,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/eu/gpt-5.5": {
      "inputUsdPerMillion": 5.5,
      "outputUsdPerMillion": 33,
      "cacheReadUsdPerMillion": 0.55,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/gpt-5.5-2026-04-23": {
      "inputUsdPerMillion": 5,
      "outputUsdPerMillion": 30,
      "cacheReadUsdPerMillion": 0.5,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/gpt-5.5-2026-04-24": {
      "inputUsdPerMillion": 5,
      "outputUsdPerMillion": 30,
      "cacheReadUsdPerMillion": 0.5,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/us/gpt-5.5-2026-04-23": {
      "inputUsdPerMillion": 5.5,
      "outputUsdPerMillion": 33,
      "cacheReadUsdPerMillion": 0.55,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/us/gpt-5.5-2026-04-24": {
      "inputUsdPerMillion": 5.5,
      "outputUsdPerMillion": 33,
      "cacheReadUsdPerMillion": 0.55,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/eu/gpt-5.5-2026-04-23": {
      "inputUsdPerMillion": 5.5,
      "outputUsdPerMillion": 33,
      "cacheReadUsdPerMillion": 0.55,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/eu/gpt-5.5-2026-04-24": {
      "inputUsdPerMillion": 5.5,
      "outputUsdPerMillion": 33,
      "cacheReadUsdPerMillion": 0.55,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/gpt-5.4-mini": {
      "inputUsdPerMillion": 0.75,
      "outputUsdPerMillion": 4.5,
      "cacheReadUsdPerMillion": 0.075,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/gpt-5.4-mini-2026-03-17": {
      "inputUsdPerMillion": 0.75,
      "outputUsdPerMillion": 4.5,
      "cacheReadUsdPerMillion": 0.075,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/gpt-5.4-nano": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 1.25,
      "cacheReadUsdPerMillion": 0.02,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/gpt-5.4-nano-2026-03-17": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 1.25,
      "cacheReadUsdPerMillion": 0.02,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/mistral-large-2402": {
      "inputUsdPerMillion": 8,
      "outputUsdPerMillion": 24,
      "provider": "azure"
    },
    "azure/mistral-large-latest": {
      "inputUsdPerMillion": 8,
      "outputUsdPerMillion": 24,
      "provider": "azure"
    },
    "azure/o1": {
      "inputUsdPerMillion": 15,
      "outputUsdPerMillion": 60,
      "cacheReadUsdPerMillion": 7.5,
      "provider": "azure"
    },
    "azure/o1-2024-12-17": {
      "inputUsdPerMillion": 15,
      "outputUsdPerMillion": 60,
      "cacheReadUsdPerMillion": 7.5,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/o1-mini": {
      "inputUsdPerMillion": 1.1,
      "outputUsdPerMillion": 4.4,
      "cacheReadUsdPerMillion": 0.55,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/o1-mini-2024-09-12": {
      "inputUsdPerMillion": 1.1,
      "outputUsdPerMillion": 4.4,
      "cacheReadUsdPerMillion": 0.55,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/o3": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 8,
      "cacheReadUsdPerMillion": 0.5,
      "provider": "azure"
    },
    "azure/o3-2025-04-16": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 8,
      "cacheReadUsdPerMillion": 0.5,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/o3-mini": {
      "inputUsdPerMillion": 1.1,
      "outputUsdPerMillion": 4.4,
      "cacheReadUsdPerMillion": 0.55,
      "provider": "azure"
    },
    "azure/o3-mini-2025-01-31": {
      "inputUsdPerMillion": 1.1,
      "outputUsdPerMillion": 4.4,
      "cacheReadUsdPerMillion": 0.55,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/o4-mini": {
      "inputUsdPerMillion": 1.1,
      "outputUsdPerMillion": 4.4,
      "cacheReadUsdPerMillion": 0.275,
      "provider": "azure"
    },
    "azure/o4-mini-2025-04-16": {
      "inputUsdPerMillion": 1.1,
      "outputUsdPerMillion": 4.4,
      "cacheReadUsdPerMillion": 0.275,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/us/gpt-4.1-2025-04-14": {
      "inputUsdPerMillion": 2.2,
      "outputUsdPerMillion": 8.8,
      "cacheReadUsdPerMillion": 0.55,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/us/gpt-4.1-mini-2025-04-14": {
      "inputUsdPerMillion": 0.44,
      "outputUsdPerMillion": 1.76,
      "cacheReadUsdPerMillion": 0.11,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/us/gpt-4.1-nano-2025-04-14": {
      "inputUsdPerMillion": 0.11,
      "outputUsdPerMillion": 0.44,
      "cacheReadUsdPerMillion": 0.028,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/us/gpt-4o-2024-08-06": {
      "inputUsdPerMillion": 2.75,
      "outputUsdPerMillion": 11,
      "cacheReadUsdPerMillion": 1.375,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/us/gpt-4o-2024-11-20": {
      "inputUsdPerMillion": 2.75,
      "outputUsdPerMillion": 11,
      "cacheReadUsdPerMillion": 1.375,
      "cacheWriteUsdPerMillion": 1.38,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/us/gpt-4o-mini-2024-07-18": {
      "inputUsdPerMillion": 0.165,
      "outputUsdPerMillion": 0.66,
      "cacheReadUsdPerMillion": 0.083,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/us/gpt-5-2025-08-07": {
      "inputUsdPerMillion": 1.375,
      "outputUsdPerMillion": 11,
      "cacheReadUsdPerMillion": 0.1375,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/us/gpt-5-mini-2025-08-07": {
      "inputUsdPerMillion": 0.275,
      "outputUsdPerMillion": 2.2,
      "cacheReadUsdPerMillion": 0.0275,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/us/gpt-5-nano-2025-08-07": {
      "inputUsdPerMillion": 0.055,
      "outputUsdPerMillion": 0.44,
      "cacheReadUsdPerMillion": 0.0055,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/us/gpt-5.1": {
      "inputUsdPerMillion": 1.375,
      "outputUsdPerMillion": 11,
      "cacheReadUsdPerMillion": 0.1375,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/us/o1-2024-12-17": {
      "inputUsdPerMillion": 16.5,
      "outputUsdPerMillion": 66,
      "cacheReadUsdPerMillion": 8.25,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/us/o1-mini-2024-09-12": {
      "inputUsdPerMillion": 1.21,
      "outputUsdPerMillion": 4.84,
      "cacheReadUsdPerMillion": 0.605,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/us/o3-2025-04-16": {
      "inputUsdPerMillion": 2.2,
      "outputUsdPerMillion": 8.8,
      "cacheReadUsdPerMillion": 0.55,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/us/o3-mini-2025-01-31": {
      "inputUsdPerMillion": 1.21,
      "outputUsdPerMillion": 4.84,
      "cacheReadUsdPerMillion": 0.605,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/us/o4-mini-2025-04-16": {
      "inputUsdPerMillion": 1.21,
      "outputUsdPerMillion": 4.84,
      "cacheReadUsdPerMillion": 0.303,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure_ai/Codestral-2501": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 0.8999999999999999,
      "provider": "azure_ai",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure_ai/FW-DeepSeek-V3.2": {
      "inputUsdPerMillion": 0.62,
      "outputUsdPerMillion": 1.85,
      "cacheReadUsdPerMillion": 0.31,
      "provider": "azure_ai",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure_ai/FW-DeepSeek-V4-Pro": {
      "inputUsdPerMillion": 1.9250000000000003,
      "outputUsdPerMillion": 3.8279999999999994,
      "cacheReadUsdPerMillion": 0.165,
      "provider": "azure_ai",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure_ai/FW-GLM-5": {
      "inputUsdPerMillion": 1.1,
      "outputUsdPerMillion": 3.52,
      "cacheReadUsdPerMillion": 0.22,
      "provider": "azure_ai",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure_ai/FW-GLM-5.1": {
      "inputUsdPerMillion": 1.54,
      "outputUsdPerMillion": 4.84,
      "cacheReadUsdPerMillion": 0.286,
      "provider": "azure_ai",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure_ai/FW-GLM-5.2": {
      "inputUsdPerMillion": 1.54,
      "outputUsdPerMillion": 4.84,
      "cacheReadUsdPerMillion": 0.15,
      "provider": "azure_ai",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure_ai/FW-GLM-5.2-Fast": {
      "inputUsdPerMillion": 2.31,
      "outputUsdPerMillion": 7.26,
      "cacheReadUsdPerMillion": 0.23099999999999998,
      "provider": "azure_ai",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure_ai/FW-Inkling": {
      "inputUsdPerMillion": 1.1,
      "outputUsdPerMillion": 4.46,
      "cacheReadUsdPerMillion": 0.19,
      "provider": "azure_ai",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure_ai/FW-Kimi-K2.5": {
      "inputUsdPerMillion": 0.66,
      "outputUsdPerMillion": 3.3000000000000003,
      "cacheReadUsdPerMillion": 0.11,
      "provider": "azure_ai",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure_ai/FW-Kimi-K2.6": {
      "inputUsdPerMillion": 1.045,
      "outputUsdPerMillion": 4.4,
      "cacheReadUsdPerMillion": 0.176,
      "provider": "azure_ai",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure_ai/FW-Kimi-K2.7-Code": {
      "inputUsdPerMillion": 1.0499999999999998,
      "outputUsdPerMillion": 4.4,
      "cacheReadUsdPerMillion": 0.21,
      "provider": "azure_ai",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure_ai/FW-Kimi-K3": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 15,
      "cacheReadUsdPerMillion": 0.3,
      "provider": "azure_ai",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure_ai/FW-MiniMax-M2.5": {
      "inputUsdPerMillion": 0.33,
      "outputUsdPerMillion": 1.32,
      "cacheReadUsdPerMillion": 0.032999999999999995,
      "provider": "azure_ai",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure_ai/FW-MiniMax-M3": {
      "inputUsdPerMillion": 0.33,
      "outputUsdPerMillion": 1.32,
      "cacheReadUsdPerMillion": 0.06599999999999999,
      "provider": "azure_ai",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure_ai/FW-Nemotron-Lightning-3.5-30B-A3B": {
      "inputUsdPerMillion": 0.06,
      "outputUsdPerMillion": 0.22,
      "cacheReadUsdPerMillion": 0.01,
      "provider": "azure_ai",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure_ai/FW-Nemotron-3-Ultra-NVFP4": {
      "inputUsdPerMillion": 0.66,
      "outputUsdPerMillion": 2.64,
      "cacheReadUsdPerMillion": 0.13,
      "provider": "azure_ai",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure_ai/MAI-Thinking-1": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 8,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "provider": "azure_ai",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure_ai/Llama-3.3-70B-Instruct": {
      "inputUsdPerMillion": 0.71,
      "outputUsdPerMillion": 0.71,
      "provider": "azure_ai",
      "sourceUrl": "https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/models-sold-directly-by-azure"
    },
    "azure_ai/Llama-4-Maverick-17B-128E-Instruct-FP8": {
      "inputUsdPerMillion": 0.25,
      "outputUsdPerMillion": 1,
      "provider": "azure_ai",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure_ai/Llama-4-Scout-17B-16E-Instruct": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.78,
      "provider": "azure_ai",
      "sourceUrl": "https://azure.microsoft.com/en-us/blog/introducing-the-llama-4-herd-in-azure-ai-foundry-and-azure-databricks/"
    },
    "azure_ai/Meta-Llama-3-70B-Instruct": {
      "inputUsdPerMillion": 1.1,
      "outputUsdPerMillion": 0.37,
      "provider": "azure_ai",
      "sourceUrl": "https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/retired-models"
    },
    "azure_ai/Meta-Llama-3.1-70B-Instruct": {
      "inputUsdPerMillion": 2.68,
      "outputUsdPerMillion": 3.54,
      "provider": "azure_ai",
      "sourceUrl": "https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/retired-models"
    },
    "azure_ai/Phi-3-medium-128k-instruct": {
      "inputUsdPerMillion": 0.16999999999999998,
      "outputUsdPerMillion": 0.6799999999999999,
      "provider": "azure_ai",
      "sourceUrl": "https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/retired-models"
    },
    "azure_ai/Phi-3-medium-4k-instruct": {
      "inputUsdPerMillion": 0.16999999999999998,
      "outputUsdPerMillion": 0.6799999999999999,
      "provider": "azure_ai",
      "sourceUrl": "https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/retired-models"
    },
    "azure_ai/Phi-3-mini-128k-instruct": {
      "inputUsdPerMillion": 0.13,
      "outputUsdPerMillion": 0.52,
      "provider": "azure_ai",
      "sourceUrl": "https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/retired-models"
    },
    "azure_ai/Phi-3-mini-4k-instruct": {
      "inputUsdPerMillion": 0.13,
      "outputUsdPerMillion": 0.52,
      "provider": "azure_ai",
      "sourceUrl": "https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/retired-models"
    },
    "azure_ai/Phi-3-small-128k-instruct": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.6,
      "provider": "azure_ai",
      "sourceUrl": "https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/retired-models"
    },
    "azure_ai/Phi-3-small-8k-instruct": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.6,
      "provider": "azure_ai",
      "sourceUrl": "https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/retired-models"
    },
    "azure_ai/Phi-3.5-MoE-instruct": {
      "inputUsdPerMillion": 0.16,
      "outputUsdPerMillion": 0.64,
      "provider": "azure_ai",
      "sourceUrl": "https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/retired-models"
    },
    "azure_ai/Phi-3.5-mini-instruct": {
      "inputUsdPerMillion": 0.13,
      "outputUsdPerMillion": 0.52,
      "provider": "azure_ai",
      "sourceUrl": "https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/retired-models"
    },
    "azure_ai/Phi-3.5-vision-instruct": {
      "inputUsdPerMillion": 0.13,
      "outputUsdPerMillion": 0.52,
      "provider": "azure_ai",
      "sourceUrl": "https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/retired-models"
    },
    "azure_ai/Phi-4": {
      "inputUsdPerMillion": 0.125,
      "outputUsdPerMillion": 0.5,
      "provider": "azure_ai",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure_ai/Phi-4-mini-instruct": {
      "inputUsdPerMillion": 0.075,
      "outputUsdPerMillion": 0.3,
      "provider": "azure_ai",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure_ai/Phi-4-multimodal-instruct": {
      "inputUsdPerMillion": 0.08,
      "outputUsdPerMillion": 0.32,
      "provider": "azure_ai",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure_ai/Phi-4-mini-reasoning": {
      "inputUsdPerMillion": 0.075,
      "outputUsdPerMillion": 0.3,
      "provider": "azure_ai",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure_ai/Phi-4-reasoning": {
      "inputUsdPerMillion": 0.125,
      "outputUsdPerMillion": 0.5,
      "provider": "azure_ai",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure_ai/cohere-command-a": {
      "inputUsdPerMillion": 2.5,
      "outputUsdPerMillion": 10,
      "provider": "azure_ai",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure_ai/MAI-DS-R1": {
      "inputUsdPerMillion": 1.35,
      "outputUsdPerMillion": 5.4,
      "provider": "azure_ai",
      "sourceUrl": "https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/retired-models"
    },
    "azure_ai/deepseek-v3.2": {
      "inputUsdPerMillion": 0.58,
      "outputUsdPerMillion": 1.68,
      "provider": "azure_ai",
      "sourceUrl": "https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/models-sold-directly-by-azure"
    },
    "azure_ai/deepseek-v3.2-speciale": {
      "inputUsdPerMillion": 0.58,
      "outputUsdPerMillion": 1.68,
      "provider": "azure_ai",
      "sourceUrl": "https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/models-sold-directly-by-azure"
    },
    "azure_ai/deepseek-v3": {
      "inputUsdPerMillion": 1.1400000000000001,
      "outputUsdPerMillion": 4.5600000000000005,
      "provider": "azure_ai",
      "sourceUrl": "https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/retired-models"
    },
    "azure_ai/deepseek-v4-pro": {
      "inputUsdPerMillion": 1.74,
      "outputUsdPerMillion": 3.48,
      "cacheReadUsdPerMillion": 0.145,
      "provider": "azure_ai",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure_ai/deepseek-v4-flash": {
      "inputUsdPerMillion": 0.19,
      "outputUsdPerMillion": 0.51,
      "cacheReadUsdPerMillion": 0.028,
      "provider": "azure_ai",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure_ai/DeepSeek-V4-Flash-0731": {
      "inputUsdPerMillion": 0.44,
      "outputUsdPerMillion": 1.32,
      "cacheReadUsdPerMillion": 0.014,
      "provider": "azure_ai",
      "sourceUrl": "https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/models-sold-directly-by-azure"
    },
    "azure_ai/grok-4": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 15,
      "provider": "azure_ai",
      "sourceUrl": "https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/models-sold-directly-by-azure"
    },
    "azure_ai/grok-4.3": {
      "inputUsdPerMillion": 1.25,
      "outputUsdPerMillion": 2.5,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "provider": "azure_ai",
      "sourceUrl": "https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/models-sold-directly-by-azure"
    },
    "azure_ai/grok-4.6": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 6,
      "cacheReadUsdPerMillion": 0.5,
      "provider": "azure_ai",
      "sourceUrl": "https://azure.microsoft.com/en-us/pricing/details/ai-foundry-models/grok/"
    },
    "azure_ai/grok-4-20-reasoning": {
      "inputUsdPerMillion": 1.25,
      "outputUsdPerMillion": 2.5,
      "cacheReadUsdPerMillion": 1.25,
      "provider": "azure_ai",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure_ai/grok-4-20-non-reasoning": {
      "inputUsdPerMillion": 1.25,
      "outputUsdPerMillion": 2.5,
      "cacheReadUsdPerMillion": 1.25,
      "provider": "azure_ai",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure_ai/grok-4-1-fast-non-reasoning": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.5,
      "provider": "azure_ai",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure_ai/grok-4-1-fast-reasoning": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.5,
      "provider": "azure_ai",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure_ai/grok-code-fast-1": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 1.5,
      "provider": "azure_ai",
      "sourceUrl": "https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/models-sold-directly-by-azure"
    },
    "azure_ai/jais-30b-chat": {
      "inputUsdPerMillion": 3200,
      "outputUsdPerMillion": 9710,
      "provider": "azure_ai",
      "sourceUrl": "https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/retired-models"
    },
    "azure_ai/jamba-instruct": {
      "inputUsdPerMillion": 0.5,
      "outputUsdPerMillion": 0.7,
      "provider": "azure_ai",
      "sourceUrl": "https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/retired-models"
    },
    "azure_ai/kimi-k2.5": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 3,
      "cacheReadUsdPerMillion": 0.09999999999999999,
      "provider": "azure_ai",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure_ai/kimi-k2.6": {
      "inputUsdPerMillion": 0.95,
      "outputUsdPerMillion": 4,
      "cacheReadUsdPerMillion": 0.16,
      "provider": "azure_ai",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure_ai/ministral-3b": {
      "inputUsdPerMillion": 0.04,
      "outputUsdPerMillion": 0.04,
      "provider": "azure_ai",
      "sourceUrl": "https://marketplace.microsoft.com/en/marketplace/apps/000-000.ministral-3b-2410-offer?tab=Overview"
    },
    "azure_ai/mistral-large": {
      "inputUsdPerMillion": 4,
      "outputUsdPerMillion": 12,
      "provider": "azure_ai",
      "sourceUrl": "https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/retired-models"
    },
    "azure_ai/mistral-large-2407": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 6,
      "provider": "azure_ai",
      "sourceUrl": "https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/retired-models"
    },
    "azure_ai/mistral-large-latest": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 6,
      "provider": "azure_ai",
      "sourceUrl": "https://marketplace.microsoft.com/en/marketplace/apps/000-000.mistral-ai-large-2407-offer?tab=Overview"
    },
    "azure_ai/mistral-large-3": {
      "inputUsdPerMillion": 0.5,
      "outputUsdPerMillion": 1.5,
      "provider": "azure_ai",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure_ai/mistral-medium-2505": {
      "inputUsdPerMillion": 0.39999999999999997,
      "outputUsdPerMillion": 2,
      "provider": "azure_ai"
    },
    "azure_ai/mistral-nemo": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.15,
      "provider": "azure_ai",
      "sourceUrl": "https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/retired-models"
    },
    "azure_ai/mistral-small": {
      "inputUsdPerMillion": 1,
      "outputUsdPerMillion": 3,
      "provider": "azure_ai",
      "sourceUrl": "https://learn.microsoft.com/en-us/azure/foundry/openai/concepts/retired-models"
    },
    "azure_ai/mistral-small-2503": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.3,
      "provider": "azure_ai"
    },
    "babbage-002": {
      "inputUsdPerMillion": 0.39999999999999997,
      "outputUsdPerMillion": 0.39999999999999997,
      "provider": "text-completion-openai",
      "sourceUrl": "https://developers.openai.com/api/docs/pricing"
    },
    "bedrock/ap-northeast-1/anthropic.claude-instant-v1": {
      "inputUsdPerMillion": 2.23,
      "outputUsdPerMillion": 7.55,
      "provider": "bedrock"
    },
    "bedrock/ap-northeast-1/anthropic.claude-v1": {
      "inputUsdPerMillion": 8,
      "outputUsdPerMillion": 24,
      "provider": "bedrock"
    },
    "bedrock/ap-northeast-1/anthropic.claude-v2:1": {
      "inputUsdPerMillion": 8,
      "outputUsdPerMillion": 24,
      "provider": "bedrock"
    },
    "bedrock/ap-northeast-1/deepseek.v3.2": {
      "inputUsdPerMillion": 0.74,
      "outputUsdPerMillion": 2.2199999999999998,
      "provider": "bedrock",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-deepseek-deepseek-v3-2.html"
    },
    "bedrock/ap-northeast-1/minimax.minimax-m2.1": {
      "inputUsdPerMillion": 0.36,
      "outputUsdPerMillion": 1.44,
      "provider": "bedrock",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-minimax-minimax-m2-1.html"
    },
    "bedrock/ap-northeast-1/minimax.minimax-m2.5": {
      "inputUsdPerMillion": 0.36,
      "outputUsdPerMillion": 1.44,
      "provider": "bedrock",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-minimax-minimax-m2-5.html"
    },
    "bedrock/ap-northeast-1/moonshotai.kimi-k2-thinking": {
      "inputUsdPerMillion": 0.73,
      "outputUsdPerMillion": 3.03,
      "provider": "bedrock",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-moonshot-ai-kimi-k2-thinking.html"
    },
    "bedrock/ap-northeast-1/moonshotai.kimi-k2.5": {
      "inputUsdPerMillion": 0.72,
      "outputUsdPerMillion": 3.5999999999999996,
      "provider": "bedrock",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-moonshot-ai-kimi-k2-5.html"
    },
    "bedrock/ap-northeast-1/qwen.qwen3-coder-next": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 1.44,
      "provider": "bedrock",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-qwen-qwen3-coder-next.html"
    },
    "bedrock/moonshotai.kimi-k2-thinking": {
      "inputUsdPerMillion": 0.73,
      "outputUsdPerMillion": 3.03,
      "provider": "bedrock",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-moonshot-ai-kimi-k2-thinking.html"
    },
    "bedrock/moonshotai.kimi-k2.5": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 3.03,
      "provider": "bedrock",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-moonshot-ai-kimi-k2-5.html"
    },
    "bedrock/ap-south-1/meta.llama3-70b-instruct-v1:0": {
      "inputUsdPerMillion": 3.18,
      "outputUsdPerMillion": 4.199999999999999,
      "provider": "bedrock"
    },
    "bedrock/ap-south-1/meta.llama3-8b-instruct-v1:0": {
      "inputUsdPerMillion": 0.36,
      "outputUsdPerMillion": 0.72,
      "provider": "bedrock"
    },
    "bedrock/ap-south-1/deepseek.v3.2": {
      "inputUsdPerMillion": 0.74,
      "outputUsdPerMillion": 2.2199999999999998,
      "provider": "bedrock",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-deepseek-deepseek-v3-2.html"
    },
    "bedrock/ap-south-1/minimax.minimax-m2.1": {
      "inputUsdPerMillion": 0.36,
      "outputUsdPerMillion": 1.44,
      "provider": "bedrock",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-minimax-minimax-m2-1.html"
    },
    "bedrock/ap-south-1/minimax.minimax-m2.5": {
      "inputUsdPerMillion": 0.36,
      "outputUsdPerMillion": 1.44,
      "provider": "bedrock",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-minimax-minimax-m2-5.html"
    },
    "bedrock/ap-south-1/moonshotai.kimi-k2-thinking": {
      "inputUsdPerMillion": 0.71,
      "outputUsdPerMillion": 2.94,
      "provider": "bedrock",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-moonshot-ai-kimi-k2-thinking.html"
    },
    "bedrock/ap-south-1/moonshotai.kimi-k2.5": {
      "inputUsdPerMillion": 0.72,
      "outputUsdPerMillion": 3.5999999999999996,
      "provider": "bedrock",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-moonshot-ai-kimi-k2-5.html"
    },
    "bedrock/ap-south-1/qwen.qwen3-coder-next": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 1.44,
      "provider": "bedrock",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-qwen-qwen3-coder-next.html"
    },
    "bedrock/ap-southeast-2/minimax.minimax-m2.5": {
      "inputUsdPerMillion": 0.31,
      "outputUsdPerMillion": 1.24,
      "provider": "bedrock",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-minimax-minimax-m2-5.html"
    },
    "bedrock/ap-southeast-3/deepseek.v3.2": {
      "inputUsdPerMillion": 0.74,
      "outputUsdPerMillion": 2.2199999999999998,
      "provider": "bedrock",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-deepseek-deepseek-v3-2.html"
    },
    "bedrock/ap-southeast-3/minimax.minimax-m2.1": {
      "inputUsdPerMillion": 0.36,
      "outputUsdPerMillion": 1.44,
      "provider": "bedrock",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-minimax-minimax-m2-1.html"
    },
    "bedrock/ap-southeast-3/minimax.minimax-m2.5": {
      "inputUsdPerMillion": 0.36,
      "outputUsdPerMillion": 1.44,
      "provider": "bedrock",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-minimax-minimax-m2-5.html"
    },
    "bedrock/ap-southeast-3/moonshotai.kimi-k2.5": {
      "inputUsdPerMillion": 0.72,
      "outputUsdPerMillion": 3.5999999999999996,
      "provider": "bedrock",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-moonshot-ai-kimi-k2-5.html"
    },
    "bedrock/ap-southeast-3/qwen.qwen3-coder-next": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 1.44,
      "provider": "bedrock",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-qwen-qwen3-coder-next.html"
    },
    "bedrock/ca-central-1/meta.llama3-70b-instruct-v1:0": {
      "inputUsdPerMillion": 3.05,
      "outputUsdPerMillion": 4.03,
      "provider": "bedrock"
    },
    "bedrock/ca-central-1/meta.llama3-8b-instruct-v1:0": {
      "inputUsdPerMillion": 0.35,
      "outputUsdPerMillion": 0.69,
      "provider": "bedrock"
    },
    "bedrock/eu-north-1/deepseek.v3.2": {
      "inputUsdPerMillion": 0.74,
      "outputUsdPerMillion": 2.2199999999999998,
      "provider": "bedrock",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-deepseek-deepseek-v3-2.html"
    },
    "bedrock/eu-north-1/minimax.minimax-m2.1": {
      "inputUsdPerMillion": 0.36,
      "outputUsdPerMillion": 1.44,
      "provider": "bedrock",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-minimax-minimax-m2-1.html"
    },
    "bedrock/eu-north-1/minimax.minimax-m2.5": {
      "inputUsdPerMillion": 0.36,
      "outputUsdPerMillion": 1.44,
      "provider": "bedrock",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-minimax-minimax-m2-5.html"
    },
    "bedrock/eu-north-1/moonshotai.kimi-k2.5": {
      "inputUsdPerMillion": 0.72,
      "outputUsdPerMillion": 3.5999999999999996,
      "provider": "bedrock",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-moonshot-ai-kimi-k2-5.html"
    },
    "bedrock/eu-central-1/anthropic.claude-instant-v1": {
      "inputUsdPerMillion": 2.48,
      "outputUsdPerMillion": 8.379999999999999,
      "provider": "bedrock"
    },
    "bedrock/eu-central-1/anthropic.claude-v1": {
      "inputUsdPerMillion": 8,
      "outputUsdPerMillion": 24,
      "provider": "bedrock"
    },
    "bedrock/eu-central-1/anthropic.claude-v2:1": {
      "inputUsdPerMillion": 8,
      "outputUsdPerMillion": 24,
      "provider": "bedrock"
    },
    "bedrock/eu-central-1/minimax.minimax-m2.1": {
      "inputUsdPerMillion": 0.36,
      "outputUsdPerMillion": 1.44,
      "provider": "bedrock",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-minimax-minimax-m2-1.html"
    },
    "bedrock/eu-central-1/minimax.minimax-m2.5": {
      "inputUsdPerMillion": 0.36,
      "outputUsdPerMillion": 1.44,
      "provider": "bedrock",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-minimax-minimax-m2-5.html"
    },
    "bedrock/eu-central-1/qwen.qwen3-coder-next": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 1.44,
      "provider": "bedrock",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-qwen-qwen3-coder-next.html"
    },
    "bedrock/eu-west-1/meta.llama3-70b-instruct-v1:0": {
      "inputUsdPerMillion": 2.8600000000000003,
      "outputUsdPerMillion": 3.78,
      "provider": "bedrock"
    },
    "bedrock/eu-west-1/meta.llama3-8b-instruct-v1:0": {
      "inputUsdPerMillion": 0.32,
      "outputUsdPerMillion": 0.65,
      "provider": "bedrock"
    },
    "bedrock/eu-west-1/minimax.minimax-m2.1": {
      "inputUsdPerMillion": 0.36,
      "outputUsdPerMillion": 1.44,
      "provider": "bedrock",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-minimax-minimax-m2-1.html"
    },
    "bedrock/eu-west-1/minimax.minimax-m2.5": {
      "inputUsdPerMillion": 0.36,
      "outputUsdPerMillion": 1.44,
      "provider": "bedrock",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-minimax-minimax-m2-5.html"
    },
    "bedrock/eu-west-1/qwen.qwen3-coder-next": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 1.44,
      "provider": "bedrock",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-qwen-qwen3-coder-next.html"
    },
    "bedrock/eu-west-2/meta.llama3-70b-instruct-v1:0": {
      "inputUsdPerMillion": 3.45,
      "outputUsdPerMillion": 4.55,
      "provider": "bedrock"
    },
    "bedrock/eu-west-2/meta.llama3-8b-instruct-v1:0": {
      "inputUsdPerMillion": 0.39,
      "outputUsdPerMillion": 0.78,
      "provider": "bedrock"
    },
    "bedrock/eu-west-2/minimax.minimax-m2.1": {
      "inputUsdPerMillion": 0.47,
      "outputUsdPerMillion": 1.8599999999999999,
      "provider": "bedrock",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-minimax-minimax-m2-1.html"
    },
    "bedrock/eu-west-2/minimax.minimax-m2.5": {
      "inputUsdPerMillion": 0.47,
      "outputUsdPerMillion": 1.8599999999999999,
      "provider": "bedrock",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-minimax-minimax-m2-5.html"
    },
    "bedrock/eu-west-2/nvidia.nemotron-super-3-120b": {
      "inputUsdPerMillion": 0.22999999999999998,
      "outputUsdPerMillion": 1.01,
      "provider": "bedrock",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "bedrock/eu-west-2/qwen.qwen3-coder-next": {
      "inputUsdPerMillion": 0.78,
      "outputUsdPerMillion": 1.8599999999999999,
      "provider": "bedrock",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-qwen-qwen3-coder-next.html"
    },
    "bedrock/eu-west-3/mistral.mistral-7b-instruct-v0:2": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.26,
      "provider": "bedrock"
    },
    "bedrock/eu-west-3/mistral.mistral-large-2402-v1:0": {
      "inputUsdPerMillion": 5.2,
      "outputUsdPerMillion": 15.6,
      "provider": "bedrock",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "bedrock/eu-west-3/mistral.mixtral-8x7b-instruct-v0:1": {
      "inputUsdPerMillion": 0.59,
      "outputUsdPerMillion": 0.9099999999999999,
      "provider": "bedrock"
    },
    "bedrock/eu-south-1/minimax.minimax-m2.1": {
      "inputUsdPerMillion": 0.36,
      "outputUsdPerMillion": 1.44,
      "provider": "bedrock",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-minimax-minimax-m2-1.html"
    },
    "bedrock/eu-south-1/minimax.minimax-m2.5": {
      "inputUsdPerMillion": 0.36,
      "outputUsdPerMillion": 1.44,
      "provider": "bedrock",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-minimax-minimax-m2-5.html"
    },
    "bedrock/eu-south-1/qwen.qwen3-coder-next": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 1.44,
      "provider": "bedrock",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-qwen-qwen3-coder-next.html"
    },
    "bedrock/invoke/anthropic.claude-3-5-sonnet-20240620-v1:0": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 15,
      "cacheReadUsdPerMillion": 0.3,
      "cacheWriteUsdPerMillion": 3.75,
      "provider": "bedrock"
    },
    "bedrock/sa-east-1/meta.llama3-70b-instruct-v1:0": {
      "inputUsdPerMillion": 4.45,
      "outputUsdPerMillion": 5.88,
      "provider": "bedrock"
    },
    "bedrock/sa-east-1/meta.llama3-8b-instruct-v1:0": {
      "inputUsdPerMillion": 0.5,
      "outputUsdPerMillion": 1.01,
      "provider": "bedrock"
    },
    "bedrock/sa-east-1/deepseek.v3.2": {
      "inputUsdPerMillion": 0.74,
      "outputUsdPerMillion": 2.2199999999999998,
      "provider": "bedrock",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-deepseek-deepseek-v3-2.html"
    },
    "bedrock/sa-east-1/minimax.minimax-m2.1": {
      "inputUsdPerMillion": 0.36,
      "outputUsdPerMillion": 1.44,
      "provider": "bedrock",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-minimax-minimax-m2-1.html"
    },
    "bedrock/sa-east-1/minimax.minimax-m2.5": {
      "inputUsdPerMillion": 0.36,
      "outputUsdPerMillion": 1.44,
      "provider": "bedrock",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-minimax-minimax-m2-5.html"
    },
    "bedrock/sa-east-1/moonshotai.kimi-k2-thinking": {
      "inputUsdPerMillion": 0.73,
      "outputUsdPerMillion": 3.03,
      "provider": "bedrock",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-moonshot-ai-kimi-k2-thinking.html"
    },
    "bedrock/sa-east-1/moonshotai.kimi-k2.5": {
      "inputUsdPerMillion": 0.72,
      "outputUsdPerMillion": 3.5999999999999996,
      "provider": "bedrock",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-moonshot-ai-kimi-k2-5.html"
    },
    "bedrock/sa-east-1/qwen.qwen3-coder-next": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 1.44,
      "provider": "bedrock",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-qwen-qwen3-coder-next.html"
    },
    "bedrock/us-east-1/anthropic.claude-instant-v1": {
      "inputUsdPerMillion": 0.7999999999999999,
      "outputUsdPerMillion": 2.4,
      "provider": "bedrock"
    },
    "bedrock/us-east-1/anthropic.claude-v1": {
      "inputUsdPerMillion": 8,
      "outputUsdPerMillion": 24,
      "provider": "bedrock"
    },
    "bedrock/us-east-1/anthropic.claude-v2:1": {
      "inputUsdPerMillion": 8,
      "outputUsdPerMillion": 24,
      "provider": "bedrock"
    },
    "bedrock/us-east-1/meta.llama3-70b-instruct-v1:0": {
      "inputUsdPerMillion": 2.65,
      "outputUsdPerMillion": 3.5,
      "provider": "bedrock"
    },
    "bedrock/us-east-1/meta.llama3-8b-instruct-v1:0": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 0.6,
      "provider": "bedrock"
    },
    "bedrock/us-east-1/mistral.mistral-7b-instruct-v0:2": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "bedrock"
    },
    "bedrock/us-east-1/mistral.mistral-large-2402-v1:0": {
      "inputUsdPerMillion": 4,
      "outputUsdPerMillion": 12,
      "provider": "bedrock",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "bedrock/us-east-1/mistral.mixtral-8x7b-instruct-v0:1": {
      "inputUsdPerMillion": 0.44999999999999996,
      "outputUsdPerMillion": 0.7,
      "provider": "bedrock"
    },
    "bedrock/us-east-1/deepseek.v3.2": {
      "inputUsdPerMillion": 0.62,
      "outputUsdPerMillion": 1.85,
      "provider": "bedrock",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-deepseek-deepseek-v3-2.html"
    },
    "bedrock/us-east-1/minimax.minimax-m2.1": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 1.2,
      "provider": "bedrock",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-minimax-minimax-m2-1.html"
    },
    "bedrock/us-east-1/minimax.minimax-m2.5": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 1.2,
      "provider": "bedrock",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-minimax-minimax-m2-5.html"
    },
    "bedrock/us-east-1/moonshotai.kimi-k2-thinking": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 2.5,
      "provider": "bedrock",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-moonshot-ai-kimi-k2-thinking.html"
    },
    "bedrock/us-east-1/moonshotai.kimi-k2.5": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 3,
      "provider": "bedrock",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-moonshot-ai-kimi-k2-5.html"
    },
    "bedrock/us-east-1/qwen.qwen3-coder-next": {
      "inputUsdPerMillion": 0.5,
      "outputUsdPerMillion": 1.2,
      "provider": "bedrock",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-qwen-qwen3-coder-next.html"
    },
    "bedrock/us-east-2/deepseek.v3.2": {
      "inputUsdPerMillion": 0.62,
      "outputUsdPerMillion": 1.85,
      "provider": "bedrock",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-deepseek-deepseek-v3-2.html"
    },
    "bedrock/us-east-2/minimax.minimax-m2.1": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 1.2,
      "provider": "bedrock",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-minimax-minimax-m2-1.html"
    },
    "bedrock/us-east-2/minimax.minimax-m2.5": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 1.2,
      "provider": "bedrock",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-minimax-minimax-m2-5.html"
    },
    "bedrock/us-east-2/moonshotai.kimi-k2-thinking": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 2.5,
      "provider": "bedrock",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-moonshot-ai-kimi-k2-thinking.html"
    },
    "bedrock/us-east-2/moonshotai.kimi-k2.5": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 3,
      "provider": "bedrock",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-moonshot-ai-kimi-k2-5.html"
    },
    "bedrock/us-east-2/qwen.qwen3-coder-next": {
      "inputUsdPerMillion": 0.5,
      "outputUsdPerMillion": 1.2,
      "provider": "bedrock",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-qwen-qwen3-coder-next.html"
    },
    "bedrock/us-gov-east-1/amazon.nova-pro-v1:0": {
      "inputUsdPerMillion": 0.96,
      "outputUsdPerMillion": 3.84,
      "cacheReadUsdPerMillion": 0.24,
      "provider": "bedrock"
    },
    "bedrock/us-gov-east-1/amazon.titan-text-express-v1": {
      "inputUsdPerMillion": 1.3,
      "outputUsdPerMillion": 1.7,
      "provider": "bedrock"
    },
    "bedrock/us-gov-east-1/amazon.titan-text-lite-v1": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 0.39999999999999997,
      "provider": "bedrock"
    },
    "bedrock/us-gov-east-1/amazon.titan-text-premier-v1:0": {
      "inputUsdPerMillion": 0.5,
      "outputUsdPerMillion": 1.5,
      "provider": "bedrock"
    },
    "bedrock/us-gov-east-1/anthropic.claude-sonnet-4-5-20250929-v1:0": {
      "inputUsdPerMillion": 3.5999999999999996,
      "outputUsdPerMillion": 18,
      "cacheReadUsdPerMillion": 0.36,
      "cacheWriteUsdPerMillion": 4.5,
      "provider": "bedrock"
    },
    "bedrock/us-gov-east-1/claude-sonnet-4-5-20250929-v1:0": {
      "inputUsdPerMillion": 3.5999999999999996,
      "outputUsdPerMillion": 18,
      "cacheReadUsdPerMillion": 0.36,
      "cacheWriteUsdPerMillion": 4.5,
      "provider": "bedrock"
    },
    "bedrock/us-gov-east-1/meta.llama3-70b-instruct-v1:0": {
      "inputUsdPerMillion": 2.65,
      "outputUsdPerMillion": 3.5,
      "provider": "bedrock"
    },
    "bedrock/us-gov-east-1/meta.llama3-8b-instruct-v1:0": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 2.65,
      "provider": "bedrock"
    },
    "bedrock/us-gov-west-1/amazon.nova-lite-v1:0": {
      "inputUsdPerMillion": 0.072,
      "outputUsdPerMillion": 0.288,
      "cacheReadUsdPerMillion": 0.018,
      "provider": "bedrock"
    },
    "bedrock/us-gov-west-1/amazon.nova-micro-v1:0": {
      "inputUsdPerMillion": 0.041999999999999996,
      "outputUsdPerMillion": 0.16799999999999998,
      "cacheReadUsdPerMillion": 0.010499999999999999,
      "provider": "bedrock"
    },
    "bedrock/us-gov-west-1/amazon.nova-pro-v1:0": {
      "inputUsdPerMillion": 0.96,
      "outputUsdPerMillion": 3.84,
      "cacheReadUsdPerMillion": 0.24,
      "provider": "bedrock"
    },
    "bedrock/us-gov-west-1/amazon.titan-text-express-v1": {
      "inputUsdPerMillion": 1.3,
      "outputUsdPerMillion": 1.7,
      "provider": "bedrock"
    },
    "bedrock/us-gov-west-1/amazon.titan-text-lite-v1": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 0.39999999999999997,
      "provider": "bedrock"
    },
    "bedrock/us-gov-west-1/amazon.titan-text-premier-v1:0": {
      "inputUsdPerMillion": 0.5,
      "outputUsdPerMillion": 1.5,
      "provider": "bedrock"
    },
    "bedrock/us-gov-west-1/anthropic.claude-sonnet-4-5-20250929-v1:0": {
      "inputUsdPerMillion": 3.5999999999999996,
      "outputUsdPerMillion": 18,
      "cacheReadUsdPerMillion": 0.36,
      "cacheWriteUsdPerMillion": 4.5,
      "provider": "bedrock"
    },
    "bedrock/us-gov-west-1/claude-sonnet-4-5-20250929-v1:0": {
      "inputUsdPerMillion": 3.5999999999999996,
      "outputUsdPerMillion": 18,
      "cacheReadUsdPerMillion": 0.36,
      "cacheWriteUsdPerMillion": 4.5,
      "provider": "bedrock"
    },
    "bedrock/us-gov-west-1/meta.llama3-70b-instruct-v1:0": {
      "inputUsdPerMillion": 2.65,
      "outputUsdPerMillion": 3.5,
      "provider": "bedrock"
    },
    "bedrock/us-gov-west-1/meta.llama3-8b-instruct-v1:0": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 0.6,
      "provider": "bedrock"
    },
    "bedrock/us-west-1/meta.llama3-70b-instruct-v1:0": {
      "inputUsdPerMillion": 2.65,
      "outputUsdPerMillion": 3.5,
      "provider": "bedrock"
    },
    "bedrock/us-west-1/meta.llama3-8b-instruct-v1:0": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 0.6,
      "provider": "bedrock"
    },
    "bedrock/us-west-2/anthropic.claude-instant-v1": {
      "inputUsdPerMillion": 0.7999999999999999,
      "outputUsdPerMillion": 2.4,
      "provider": "bedrock"
    },
    "bedrock/us-west-2/anthropic.claude-v1": {
      "inputUsdPerMillion": 8,
      "outputUsdPerMillion": 24,
      "provider": "bedrock"
    },
    "bedrock/us-west-2/anthropic.claude-v2:1": {
      "inputUsdPerMillion": 8,
      "outputUsdPerMillion": 24,
      "provider": "bedrock"
    },
    "bedrock/us-west-2/mistral.mistral-7b-instruct-v0:2": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "bedrock"
    },
    "bedrock/us-west-2/mistral.mistral-large-2402-v1:0": {
      "inputUsdPerMillion": 4,
      "outputUsdPerMillion": 12,
      "provider": "bedrock",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "bedrock/us-west-2/mistral.mixtral-8x7b-instruct-v0:1": {
      "inputUsdPerMillion": 0.44999999999999996,
      "outputUsdPerMillion": 0.7,
      "provider": "bedrock"
    },
    "bedrock/us-west-2/deepseek.v3.2": {
      "inputUsdPerMillion": 0.62,
      "outputUsdPerMillion": 1.85,
      "provider": "bedrock",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-deepseek-deepseek-v3-2.html"
    },
    "bedrock/us-west-2/minimax.minimax-m2.1": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 1.2,
      "provider": "bedrock",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-minimax-minimax-m2-1.html"
    },
    "bedrock/us-west-2/minimax.minimax-m2.5": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 1.2,
      "provider": "bedrock",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-minimax-minimax-m2-5.html"
    },
    "bedrock/us-west-2/moonshotai.kimi-k2-thinking": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 2.5,
      "provider": "bedrock",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-moonshot-ai-kimi-k2-thinking.html"
    },
    "bedrock/us-west-2/moonshotai.kimi-k2.5": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 3,
      "provider": "bedrock",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-moonshot-ai-kimi-k2-5.html"
    },
    "bedrock/us-west-2/qwen.qwen3-coder-next": {
      "inputUsdPerMillion": 0.5,
      "outputUsdPerMillion": 1.2,
      "provider": "bedrock",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-qwen-qwen3-coder-next.html"
    },
    "bedrock/us.anthropic.claude-3-5-haiku-20241022-v1:0": {
      "inputUsdPerMillion": 0.7999999999999999,
      "outputUsdPerMillion": 4,
      "cacheReadUsdPerMillion": 0.08,
      "cacheWriteUsdPerMillion": 1,
      "provider": "bedrock"
    },
    "cerebras/llama-3.3-70b": {
      "inputUsdPerMillion": 0.85,
      "outputUsdPerMillion": 1.2,
      "provider": "cerebras"
    },
    "cerebras/llama3.1-70b": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 0.6,
      "provider": "cerebras"
    },
    "cerebras/llama3.1-8b": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.09999999999999999,
      "provider": "cerebras"
    },
    "cerebras/gpt-oss-120b": {
      "inputUsdPerMillion": 0.35,
      "outputUsdPerMillion": 0.75,
      "provider": "cerebras",
      "sourceUrl": "https://www.cerebras.ai/blog/openai-gpt-oss-120b-runs-fastest-on-cerebras"
    },
    "cerebras/qwen-3-32b": {
      "inputUsdPerMillion": 0.39999999999999997,
      "outputUsdPerMillion": 0.7999999999999999,
      "provider": "cerebras",
      "sourceUrl": "https://inference-docs.cerebras.ai/support/pricing"
    },
    "cerebras/qwen-3.8-27b": {
      "inputUsdPerMillion": 0.9900000000000001,
      "outputUsdPerMillion": 1.49,
      "provider": "cerebras",
      "sourceUrl": "https://api.cerebras.ai/public/v1/models/qwen-3.8-27b"
    },
    "chatdolphin": {
      "inputUsdPerMillion": 0.5,
      "outputUsdPerMillion": 0.5,
      "provider": "nlp_cloud"
    },
    "claude-haiku-4-5-20251001": {
      "inputUsdPerMillion": 1,
      "outputUsdPerMillion": 5,
      "cacheReadUsdPerMillion": 0.09999999999999999,
      "cacheWriteUsdPerMillion": 1.25,
      "provider": "anthropic"
    },
    "claude-haiku-4-5": {
      "inputUsdPerMillion": 1,
      "outputUsdPerMillion": 5,
      "cacheReadUsdPerMillion": 0.09999999999999999,
      "cacheWriteUsdPerMillion": 1.25,
      "provider": "anthropic",
      "sourceUrl": "https://platform.claude.com/docs/en/about-claude/pricing"
    },
    "claude-sonnet-4-5": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 15,
      "cacheReadUsdPerMillion": 0.3,
      "cacheWriteUsdPerMillion": 3.75,
      "provider": "anthropic",
      "sourceUrl": "https://platform.claude.com/docs/en/about-claude/pricing"
    },
    "claude-sonnet-4-5-20250929": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 15,
      "cacheReadUsdPerMillion": 0.3,
      "cacheWriteUsdPerMillion": 3.75,
      "provider": "anthropic",
      "sourceUrl": "https://docs.anthropic.com/en/docs/about-claude/pricing"
    },
    "claude-sonnet-5": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 10,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "cacheWriteUsdPerMillion": 2.5,
      "provider": "anthropic",
      "sourceUrl": "https://platform.claude.com/docs/en/about-claude/pricing"
    },
    "claude-sonnet-5-5": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 10,
      "cacheReadUsdPerMillion": 0.09999999999999999,
      "cacheWriteUsdPerMillion": 2.5,
      "provider": "anthropic",
      "sourceUrl": "https://platform.claude.com/docs/en/about-claude/pricing"
    },
    "claude-sonnet-4-6": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 15,
      "cacheReadUsdPerMillion": 0.3,
      "cacheWriteUsdPerMillion": 3.75,
      "provider": "anthropic",
      "sourceUrl": "https://platform.claude.com/docs/en/about-claude/pricing"
    },
    "claude-sonnet-4-5-20250929-v1:0": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 15,
      "cacheReadUsdPerMillion": 0.3,
      "cacheWriteUsdPerMillion": 3.75,
      "provider": "bedrock"
    },
    "claude-opus-4-5-20251101": {
      "inputUsdPerMillion": 5,
      "outputUsdPerMillion": 25,
      "cacheReadUsdPerMillion": 0.5,
      "cacheWriteUsdPerMillion": 6.25,
      "provider": "anthropic"
    },
    "claude-opus-4-5": {
      "inputUsdPerMillion": 5,
      "outputUsdPerMillion": 25,
      "cacheReadUsdPerMillion": 0.5,
      "cacheWriteUsdPerMillion": 6.25,
      "provider": "anthropic",
      "sourceUrl": "https://platform.claude.com/docs/en/about-claude/pricing"
    },
    "claude-opus-4-6": {
      "inputUsdPerMillion": 5,
      "outputUsdPerMillion": 25,
      "cacheReadUsdPerMillion": 0.5,
      "cacheWriteUsdPerMillion": 6.25,
      "provider": "anthropic",
      "sourceUrl": "https://platform.claude.com/docs/en/about-claude/pricing"
    },
    "claude-opus-4-6-20260205": {
      "inputUsdPerMillion": 5,
      "outputUsdPerMillion": 25,
      "cacheReadUsdPerMillion": 0.5,
      "cacheWriteUsdPerMillion": 6.25,
      "provider": "anthropic"
    },
    "claude-opus-4-7": {
      "inputUsdPerMillion": 5,
      "outputUsdPerMillion": 25,
      "cacheReadUsdPerMillion": 0.5,
      "cacheWriteUsdPerMillion": 6.25,
      "provider": "anthropic",
      "sourceUrl": "https://platform.claude.com/docs/en/about-claude/pricing"
    },
    "claude-opus-4-7-20260416": {
      "inputUsdPerMillion": 5,
      "outputUsdPerMillion": 25,
      "cacheReadUsdPerMillion": 0.5,
      "cacheWriteUsdPerMillion": 6.25,
      "provider": "anthropic"
    },
    "claude-fable-5": {
      "inputUsdPerMillion": 10,
      "outputUsdPerMillion": 50,
      "cacheReadUsdPerMillion": 1,
      "cacheWriteUsdPerMillion": 12.5,
      "provider": "anthropic",
      "sourceUrl": "https://platform.claude.com/docs/en/about-claude/pricing"
    },
    "claude-fable-5-1": {
      "inputUsdPerMillion": 10,
      "outputUsdPerMillion": 50,
      "cacheReadUsdPerMillion": 0.25,
      "cacheWriteUsdPerMillion": 12.5,
      "provider": "anthropic",
      "sourceUrl": "https://platform.claude.com/docs/en/about-claude/pricing"
    },
    "claude-opus-5-5": {
      "inputUsdPerMillion": 4,
      "outputUsdPerMillion": 20,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "cacheWriteUsdPerMillion": 5,
      "provider": "anthropic",
      "sourceUrl": "https://platform.claude.com/docs/en/about-claude/pricing"
    },
    "claude-opus-5": {
      "inputUsdPerMillion": 5,
      "outputUsdPerMillion": 25,
      "cacheReadUsdPerMillion": 0.5,
      "cacheWriteUsdPerMillion": 6.25,
      "provider": "anthropic",
      "sourceUrl": "https://platform.claude.com/docs/en/about-claude/pricing"
    },
    "claude-opus-4-8": {
      "inputUsdPerMillion": 5,
      "outputUsdPerMillion": 25,
      "cacheReadUsdPerMillion": 0.5,
      "cacheWriteUsdPerMillion": 6.25,
      "provider": "anthropic",
      "sourceUrl": "https://platform.claude.com/docs/en/about-claude/pricing"
    },
    "cloudflare/@cf/meta/llama-2-7b-chat-fp16": {
      "inputUsdPerMillion": 1.923,
      "outputUsdPerMillion": 1.923,
      "provider": "cloudflare"
    },
    "cloudflare/@cf/meta/llama-2-7b-chat-int8": {
      "inputUsdPerMillion": 1.923,
      "outputUsdPerMillion": 1.923,
      "provider": "cloudflare"
    },
    "cloudflare/@cf/mistral/mistral-7b-instruct-v0.1": {
      "inputUsdPerMillion": 1.923,
      "outputUsdPerMillion": 1.923,
      "provider": "cloudflare"
    },
    "cloudflare/@hf/thebloke/codellama-7b-instruct-awq": {
      "inputUsdPerMillion": 1.923,
      "outputUsdPerMillion": 1.923,
      "provider": "cloudflare"
    },
    "cloudflare/@cf/openai/gpt-oss-120b": {
      "inputUsdPerMillion": 0.35,
      "outputUsdPerMillion": 0.75,
      "provider": "cloudflare"
    },
    "cloudflare/@cf/google/gemma-2b-it-lora": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "cloudflare"
    },
    "cloudflare/@cf/meta/llama-3.2-3b-instruct": {
      "inputUsdPerMillion": 0.0509,
      "outputUsdPerMillion": 0.335,
      "provider": "cloudflare"
    },
    "cloudflare/@cf/meta/llama-guard-3-8b": {
      "inputUsdPerMillion": 0.48400000000000004,
      "outputUsdPerMillion": 0.03,
      "provider": "cloudflare"
    },
    "cloudflare/@cf/mistral/mistral-7b-instruct-v0.2-lora": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "cloudflare"
    },
    "cloudflare/@cf/moonshotai/kimi-k2.7-code": {
      "inputUsdPerMillion": 0.95,
      "outputUsdPerMillion": 4,
      "cacheReadUsdPerMillion": 0.19,
      "provider": "cloudflare"
    },
    "cloudflare/@cf/deepseek-ai/deepseek-r1-distill-qwen-32b": {
      "inputUsdPerMillion": 0.49699999999999994,
      "outputUsdPerMillion": 4.881,
      "provider": "cloudflare"
    },
    "cloudflare/@cf/meta/llama-3.1-8b-instruct-fp8": {
      "inputUsdPerMillion": 0.15200000000000002,
      "outputUsdPerMillion": 0.28700000000000003,
      "provider": "cloudflare"
    },
    "cloudflare/@cf/meta/llama-3.2-1b-instruct": {
      "inputUsdPerMillion": 0.027,
      "outputUsdPerMillion": 0.201,
      "provider": "cloudflare"
    },
    "cloudflare/@cf/moonshotai/kimi-k2.6": {
      "inputUsdPerMillion": 0.95,
      "outputUsdPerMillion": 4,
      "cacheReadUsdPerMillion": 0.16,
      "provider": "cloudflare"
    },
    "cloudflare/@cf/zai-org/glm-4.7-flash": {
      "inputUsdPerMillion": 0.060500000000000005,
      "outputUsdPerMillion": 0.39999999999999997,
      "provider": "cloudflare"
    },
    "cloudflare/@cf/meta-llama/llama-2-7b-chat-hf-lora": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "cloudflare"
    },
    "cloudflare/@cf/meta/llama-3.3-70b-instruct-fp8-fast": {
      "inputUsdPerMillion": 0.293,
      "outputUsdPerMillion": 2.2529999999999997,
      "provider": "cloudflare"
    },
    "cloudflare/@cf/ibm-granite/granite-4.0-h-micro": {
      "inputUsdPerMillion": 0.017,
      "outputUsdPerMillion": 0.112,
      "provider": "cloudflare"
    },
    "cloudflare/@cf/qwen/qwen2.5-coder-32b-instruct": {
      "inputUsdPerMillion": 0.66,
      "outputUsdPerMillion": 1,
      "provider": "cloudflare"
    },
    "cloudflare/@cf/zai-org/glm-5.2": {
      "inputUsdPerMillion": 1.4,
      "outputUsdPerMillion": 4.4,
      "cacheReadUsdPerMillion": 0.26,
      "provider": "cloudflare"
    },
    "cloudflare/@cf/nvidia/nemotron-3-120b-a12b": {
      "inputUsdPerMillion": 0.5,
      "outputUsdPerMillion": 1.5,
      "provider": "cloudflare"
    },
    "cloudflare/@cf/aisingapore/gemma-sea-lion-v4-27b-it": {
      "inputUsdPerMillion": 0.351,
      "outputUsdPerMillion": 0.5549999999999999,
      "provider": "cloudflare"
    },
    "cloudflare/@cf/qwen/qwen3-30b-a3b-fp8": {
      "inputUsdPerMillion": 0.0509,
      "outputUsdPerMillion": 0.335,
      "provider": "cloudflare"
    },
    "cloudflare/@cf/google/gemma-7b-it-lora": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "cloudflare"
    },
    "cloudflare/@cf/google/gemma-4-26b-a4b-it": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.3,
      "provider": "cloudflare"
    },
    "cloudflare/@cf/mistralai/mistral-small-3.1-24b-instruct": {
      "inputUsdPerMillion": 0.351,
      "outputUsdPerMillion": 0.5549999999999999,
      "provider": "cloudflare"
    },
    "cloudflare/@cf/meta/llama-3.2-11b-vision-instruct": {
      "inputUsdPerMillion": 0.048499999999999995,
      "outputUsdPerMillion": 0.6759999999999999,
      "provider": "cloudflare"
    },
    "cloudflare/@cf/openai/gpt-oss-20b": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.3,
      "provider": "cloudflare"
    },
    "cloudflare/@cf/meta/llama-4-scout-17b-16e-instruct": {
      "inputUsdPerMillion": 0.27,
      "outputUsdPerMillion": 0.85,
      "provider": "cloudflare"
    },
    "cloudflare/@cf/qwen/qwq-32b": {
      "inputUsdPerMillion": 0.66,
      "outputUsdPerMillion": 1,
      "provider": "cloudflare"
    },
    "codestral/codestral-2405": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "codestral",
      "sourceUrl": "https://docs.mistral.ai/capabilities/code_generation/"
    },
    "codestral/codestral-latest": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "codestral",
      "sourceUrl": "https://docs.mistral.ai/capabilities/code_generation/"
    },
    "cohere.command-light-text-v14": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 0.6,
      "provider": "bedrock",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "cohere.command-text-v14": {
      "inputUsdPerMillion": 1,
      "outputUsdPerMillion": 2,
      "provider": "bedrock",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "command-a-03-2025": {
      "inputUsdPerMillion": 2.5,
      "outputUsdPerMillion": 10,
      "provider": "cohere_chat"
    },
    "c4ai-aya-expanse-32b": {
      "inputUsdPerMillion": 0.5,
      "outputUsdPerMillion": 1.5,
      "provider": "cohere_chat",
      "sourceUrl": "https://docs.cohere.com/docs/models"
    },
    "command-a-plus-05-2026": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "cohere_chat",
      "sourceUrl": "https://docs.cohere.com/docs/command-a-plus"
    },
    "command-nightly": {
      "inputUsdPerMillion": 1,
      "outputUsdPerMillion": 2,
      "provider": "cohere"
    },
    "command-r-08-2024": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.6,
      "provider": "cohere_chat"
    },
    "command-r-plus-08-2024": {
      "inputUsdPerMillion": 2.5,
      "outputUsdPerMillion": 10,
      "provider": "cohere_chat"
    },
    "command-r7b-12-2024": {
      "inputUsdPerMillion": 0.0375,
      "outputUsdPerMillion": 0.15,
      "provider": "cohere_chat",
      "sourceUrl": "https://docs.cohere.com/v2/docs/command-r7b"
    },
    "computer-use-preview": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 12,
      "provider": "openai",
      "sourceUrl": "https://platform.openai.com/docs/models/computer-use-preview"
    },
    "deepseek-chat": {
      "inputUsdPerMillion": 0.28,
      "outputUsdPerMillion": 0.42,
      "cacheReadUsdPerMillion": 0.028,
      "provider": "deepseek",
      "sourceUrl": "https://api-docs.deepseek.com/quick_start/pricing"
    },
    "deepseek-reasoner": {
      "inputUsdPerMillion": 0.28,
      "outputUsdPerMillion": 0.42,
      "cacheReadUsdPerMillion": 0.028,
      "provider": "deepseek",
      "sourceUrl": "https://api-docs.deepseek.com/quick_start/pricing"
    },
    "dashscope/deepseek-v4-flash": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.39999999999999997,
      "cacheReadUsdPerMillion": 0.04,
      "provider": "dashscope",
      "sourceUrl": "https://www.alibabacloud.com/help/en/model-studio/models"
    },
    "dashscope/deepseek-v4-flash-0731": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.39999999999999997,
      "cacheReadUsdPerMillion": 0.04,
      "provider": "dashscope",
      "sourceUrl": "https://www.alibabacloud.com/help/en/model-studio/models"
    },
    "dashscope/deepseek-v4-pro": {
      "inputUsdPerMillion": 2.4,
      "outputUsdPerMillion": 4.8,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "provider": "dashscope",
      "sourceUrl": "https://www.alibabacloud.com/help/en/model-studio/models"
    },
    "dashscope/glm-5.1": {
      "inputUsdPerMillion": 1.4,
      "outputUsdPerMillion": 4.4,
      "cacheReadUsdPerMillion": 0.26,
      "provider": "dashscope",
      "sourceUrl": "https://www.alibabacloud.com/help/en/model-studio/models"
    },
    "dashscope/glm-5.2": {
      "inputUsdPerMillion": 1.4,
      "outputUsdPerMillion": 4.4,
      "cacheReadUsdPerMillion": 0.28,
      "provider": "dashscope",
      "sourceUrl": "https://www.alibabacloud.com/help/en/model-studio/models"
    },
    "dashscope/kimi-k2.7-code": {
      "inputUsdPerMillion": 0.95,
      "outputUsdPerMillion": 4,
      "cacheReadUsdPerMillion": 0.19,
      "provider": "dashscope",
      "sourceUrl": "https://www.alibabacloud.com/help/en/model-studio/models"
    },
    "dashscope/qwen-coder": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 1.5,
      "provider": "dashscope",
      "sourceUrl": "https://www.alibabacloud.com/help/en/model-studio/models"
    },
    "dashscope/qwen-max": {
      "inputUsdPerMillion": 1.5999999999999999,
      "outputUsdPerMillion": 6.3999999999999995,
      "provider": "dashscope",
      "sourceUrl": "https://www.alibabacloud.com/help/en/model-studio/models"
    },
    "dashscope/qwen-plus": {
      "inputUsdPerMillion": 0.39999999999999997,
      "outputUsdPerMillion": 1.2,
      "provider": "dashscope",
      "sourceUrl": "https://www.alibabacloud.com/help/en/model-studio/models"
    },
    "dashscope/qwen-plus-2025-01-25": {
      "inputUsdPerMillion": 0.39999999999999997,
      "outputUsdPerMillion": 1.2,
      "provider": "dashscope",
      "sourceUrl": "https://www.alibabacloud.com/help/en/model-studio/models"
    },
    "dashscope/qwen-plus-2025-04-28": {
      "inputUsdPerMillion": 0.39999999999999997,
      "outputUsdPerMillion": 1.2,
      "reasoningUsdPerMillion": 4,
      "provider": "dashscope",
      "sourceUrl": "https://www.alibabacloud.com/help/en/model-studio/models"
    },
    "dashscope/qwen-plus-2025-07-14": {
      "inputUsdPerMillion": 0.39999999999999997,
      "outputUsdPerMillion": 1.2,
      "reasoningUsdPerMillion": 4,
      "provider": "dashscope",
      "sourceUrl": "https://www.alibabacloud.com/help/en/model-studio/models"
    },
    "dashscope/qwen-turbo": {
      "inputUsdPerMillion": 0.049999999999999996,
      "outputUsdPerMillion": 0.19999999999999998,
      "reasoningUsdPerMillion": 0.5,
      "provider": "dashscope",
      "sourceUrl": "https://www.alibabacloud.com/help/en/model-studio/models"
    },
    "dashscope/qwen-turbo-2024-11-01": {
      "inputUsdPerMillion": 0.049999999999999996,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "dashscope",
      "sourceUrl": "https://www.alibabacloud.com/help/en/model-studio/models"
    },
    "dashscope/qwen-turbo-2025-04-28": {
      "inputUsdPerMillion": 0.049999999999999996,
      "outputUsdPerMillion": 0.19999999999999998,
      "reasoningUsdPerMillion": 0.5,
      "provider": "dashscope",
      "sourceUrl": "https://www.alibabacloud.com/help/en/model-studio/models"
    },
    "dashscope/qwen-turbo-latest": {
      "inputUsdPerMillion": 0.049999999999999996,
      "outputUsdPerMillion": 0.19999999999999998,
      "reasoningUsdPerMillion": 0.5,
      "provider": "dashscope",
      "sourceUrl": "https://www.alibabacloud.com/help/en/model-studio/models"
    },
    "dashscope/qwen3-next-80b-a3b-instruct": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 1.2,
      "provider": "dashscope",
      "sourceUrl": "https://www.alibabacloud.com/help/en/model-studio/model-pricing"
    },
    "dashscope/qwen3-next-80b-a3b-thinking": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 1.2,
      "provider": "dashscope",
      "sourceUrl": "https://www.alibabacloud.com/help/en/model-studio/model-pricing"
    },
    "dashscope/qwen3-vl-235b-a22b-instruct": {
      "inputUsdPerMillion": 0.39999999999999997,
      "outputUsdPerMillion": 1.5999999999999999,
      "provider": "dashscope",
      "sourceUrl": "https://www.alibabacloud.com/help/en/model-studio/model-pricing"
    },
    "dashscope/qwen3-vl-235b-a22b-thinking": {
      "inputUsdPerMillion": 0.39999999999999997,
      "outputUsdPerMillion": 4,
      "provider": "dashscope",
      "sourceUrl": "https://www.alibabacloud.com/help/en/model-studio/model-pricing"
    },
    "dashscope/qwen3-vl-32b-instruct": {
      "inputUsdPerMillion": 0.16,
      "outputUsdPerMillion": 0.64,
      "provider": "dashscope",
      "sourceUrl": "https://www.alibabacloud.com/help/en/model-studio/model-pricing"
    },
    "dashscope/qwen3-vl-32b-thinking": {
      "inputUsdPerMillion": 0.16,
      "outputUsdPerMillion": 2.87,
      "provider": "dashscope",
      "sourceUrl": "https://www.alibabacloud.com/help/en/model-studio/model-pricing"
    },
    "dashscope/qwen3.7-max": {
      "inputUsdPerMillion": 2.5,
      "outputUsdPerMillion": 7.5,
      "cacheReadUsdPerMillion": 0.5,
      "provider": "dashscope",
      "sourceUrl": "https://www.alibabacloud.com/help/en/model-studio/models"
    },
    "dashscope/qwen3.8-max": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 6,
      "cacheReadUsdPerMillion": 0.25,
      "provider": "dashscope",
      "sourceUrl": "https://www.alibabacloud.com/help/en/model-studio/models"
    },
    "dashscope/qwen3.8-flash": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.47,
      "cacheReadUsdPerMillion": 0.016,
      "cacheWriteUsdPerMillion": 0.19999999999999998,
      "provider": "dashscope",
      "sourceUrl": "https://docs.modelstudio.console.alibabacloud.com/en/model-studio/model-pricing"
    },
    "dashscope/qwen3.8-omni-flash": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.47,
      "cacheReadUsdPerMillion": 0.016,
      "provider": "dashscope",
      "sourceUrl": "https://docs.modelstudio.console.alibabacloud.com/en/model-studio/model-pricing"
    },
    "dashscope/qwq-plus": {
      "inputUsdPerMillion": 0.7999999999999999,
      "outputUsdPerMillion": 2.4,
      "provider": "dashscope",
      "sourceUrl": "https://www.alibabacloud.com/help/en/model-studio/models"
    },
    "qwencloud/deepseek-v4-flash": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.39999999999999997,
      "cacheReadUsdPerMillion": 0.04,
      "provider": "qwencloud",
      "sourceUrl": "https://www.qwencloud.com/models"
    },
    "qwencloud/deepseek-v4-flash-0731": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.39999999999999997,
      "cacheReadUsdPerMillion": 0.04,
      "provider": "qwencloud",
      "sourceUrl": "https://www.qwencloud.com/models"
    },
    "qwencloud/deepseek-v4-pro": {
      "inputUsdPerMillion": 2.4,
      "outputUsdPerMillion": 4.8,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "provider": "qwencloud",
      "sourceUrl": "https://www.qwencloud.com/models"
    },
    "qwencloud/glm-5.1": {
      "inputUsdPerMillion": 1.4,
      "outputUsdPerMillion": 4.4,
      "cacheReadUsdPerMillion": 0.26,
      "provider": "qwencloud",
      "sourceUrl": "https://www.qwencloud.com/models"
    },
    "qwencloud/glm-5.2": {
      "inputUsdPerMillion": 1.4,
      "outputUsdPerMillion": 4.4,
      "cacheReadUsdPerMillion": 0.28,
      "provider": "qwencloud",
      "sourceUrl": "https://www.qwencloud.com/models"
    },
    "qwencloud/kimi-k2.7-code": {
      "inputUsdPerMillion": 0.95,
      "outputUsdPerMillion": 4,
      "cacheReadUsdPerMillion": 0.19,
      "provider": "qwencloud",
      "sourceUrl": "https://www.qwencloud.com/models"
    },
    "qwencloud/qwen-coder": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 1.5,
      "provider": "qwencloud",
      "sourceUrl": "https://www.qwencloud.com/models"
    },
    "qwencloud/qwen-max": {
      "inputUsdPerMillion": 1.5999999999999999,
      "outputUsdPerMillion": 6.3999999999999995,
      "provider": "qwencloud",
      "sourceUrl": "https://www.qwencloud.com/models"
    },
    "qwencloud/qwen-plus": {
      "inputUsdPerMillion": 0.39999999999999997,
      "outputUsdPerMillion": 1.2,
      "provider": "qwencloud",
      "sourceUrl": "https://www.qwencloud.com/models"
    },
    "qwencloud/qwen-plus-2025-01-25": {
      "inputUsdPerMillion": 0.39999999999999997,
      "outputUsdPerMillion": 1.2,
      "provider": "qwencloud",
      "sourceUrl": "https://www.qwencloud.com/models"
    },
    "qwencloud/qwen-plus-2025-04-28": {
      "inputUsdPerMillion": 0.39999999999999997,
      "outputUsdPerMillion": 1.2,
      "reasoningUsdPerMillion": 4,
      "provider": "qwencloud",
      "sourceUrl": "https://www.qwencloud.com/models"
    },
    "qwencloud/qwen-plus-2025-07-14": {
      "inputUsdPerMillion": 0.39999999999999997,
      "outputUsdPerMillion": 1.2,
      "reasoningUsdPerMillion": 4,
      "provider": "qwencloud",
      "sourceUrl": "https://www.qwencloud.com/models"
    },
    "qwencloud/qwen-turbo": {
      "inputUsdPerMillion": 0.049999999999999996,
      "outputUsdPerMillion": 0.19999999999999998,
      "reasoningUsdPerMillion": 0.5,
      "provider": "qwencloud",
      "sourceUrl": "https://www.qwencloud.com/models"
    },
    "qwencloud/qwen-turbo-2024-11-01": {
      "inputUsdPerMillion": 0.049999999999999996,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "qwencloud",
      "sourceUrl": "https://www.qwencloud.com/models"
    },
    "qwencloud/qwen-turbo-2025-04-28": {
      "inputUsdPerMillion": 0.049999999999999996,
      "outputUsdPerMillion": 0.19999999999999998,
      "reasoningUsdPerMillion": 0.5,
      "provider": "qwencloud",
      "sourceUrl": "https://www.qwencloud.com/models"
    },
    "qwencloud/qwen-turbo-latest": {
      "inputUsdPerMillion": 0.049999999999999996,
      "outputUsdPerMillion": 0.19999999999999998,
      "reasoningUsdPerMillion": 0.5,
      "provider": "qwencloud",
      "sourceUrl": "https://www.qwencloud.com/models"
    },
    "qwencloud/qwen3-next-80b-a3b-instruct": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 1.2,
      "provider": "qwencloud",
      "sourceUrl": "https://www.qwencloud.com/models"
    },
    "qwencloud/qwen3-next-80b-a3b-thinking": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 1.2,
      "provider": "qwencloud",
      "sourceUrl": "https://www.qwencloud.com/models"
    },
    "qwencloud/qwen3-vl-235b-a22b-instruct": {
      "inputUsdPerMillion": 0.39999999999999997,
      "outputUsdPerMillion": 1.5999999999999999,
      "provider": "qwencloud",
      "sourceUrl": "https://www.qwencloud.com/models"
    },
    "qwencloud/qwen3-vl-235b-a22b-thinking": {
      "inputUsdPerMillion": 0.39999999999999997,
      "outputUsdPerMillion": 4,
      "provider": "qwencloud",
      "sourceUrl": "https://www.qwencloud.com/models"
    },
    "qwencloud/qwen3-vl-32b-instruct": {
      "inputUsdPerMillion": 0.16,
      "outputUsdPerMillion": 0.64,
      "provider": "qwencloud",
      "sourceUrl": "https://www.qwencloud.com/models"
    },
    "qwencloud/qwen3-vl-32b-thinking": {
      "inputUsdPerMillion": 0.16,
      "outputUsdPerMillion": 2.87,
      "provider": "qwencloud",
      "sourceUrl": "https://www.qwencloud.com/models"
    },
    "qwencloud/qwen3.7-max": {
      "inputUsdPerMillion": 2.5,
      "outputUsdPerMillion": 7.5,
      "cacheReadUsdPerMillion": 0.5,
      "provider": "qwencloud",
      "sourceUrl": "https://www.qwencloud.com/models"
    },
    "qwencloud/qwen3.8-max": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 6,
      "cacheReadUsdPerMillion": 0.25,
      "provider": "qwencloud",
      "sourceUrl": "https://www.qwencloud.com/models"
    },
    "qwencloud/qwq-plus": {
      "inputUsdPerMillion": 0.7999999999999999,
      "outputUsdPerMillion": 2.4,
      "provider": "qwencloud",
      "sourceUrl": "https://www.qwencloud.com/models"
    },
    "qwen_ai_platform/deepseek-v4-flash": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.39999999999999997,
      "cacheReadUsdPerMillion": 0.04,
      "provider": "qwen_ai_platform",
      "sourceUrl": "https://www.alibabacloud.com/help/en/model-studio/models"
    },
    "qwen_ai_platform/deepseek-v4-flash-0731": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.39999999999999997,
      "cacheReadUsdPerMillion": 0.04,
      "provider": "qwen_ai_platform",
      "sourceUrl": "https://www.alibabacloud.com/help/en/model-studio/models"
    },
    "qwen_ai_platform/deepseek-v4-pro": {
      "inputUsdPerMillion": 2.4,
      "outputUsdPerMillion": 4.8,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "provider": "qwen_ai_platform",
      "sourceUrl": "https://www.alibabacloud.com/help/en/model-studio/models"
    },
    "qwen_ai_platform/glm-5.1": {
      "inputUsdPerMillion": 1.4,
      "outputUsdPerMillion": 4.4,
      "cacheReadUsdPerMillion": 0.26,
      "provider": "qwen_ai_platform",
      "sourceUrl": "https://www.alibabacloud.com/help/en/model-studio/models"
    },
    "qwen_ai_platform/glm-5.2": {
      "inputUsdPerMillion": 1.4,
      "outputUsdPerMillion": 4.4,
      "cacheReadUsdPerMillion": 0.28,
      "provider": "qwen_ai_platform",
      "sourceUrl": "https://www.alibabacloud.com/help/en/model-studio/models"
    },
    "qwen_ai_platform/kimi-k2.7-code": {
      "inputUsdPerMillion": 0.95,
      "outputUsdPerMillion": 4,
      "cacheReadUsdPerMillion": 0.19,
      "provider": "qwen_ai_platform",
      "sourceUrl": "https://www.alibabacloud.com/help/en/model-studio/models"
    },
    "qwen_ai_platform/qwen-coder": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 1.5,
      "provider": "qwen_ai_platform",
      "sourceUrl": "https://www.alibabacloud.com/help/en/model-studio/models"
    },
    "qwen_ai_platform/qwen-max": {
      "inputUsdPerMillion": 1.5999999999999999,
      "outputUsdPerMillion": 6.3999999999999995,
      "provider": "qwen_ai_platform",
      "sourceUrl": "https://www.alibabacloud.com/help/en/model-studio/models"
    },
    "qwen_ai_platform/qwen-plus": {
      "inputUsdPerMillion": 0.39999999999999997,
      "outputUsdPerMillion": 1.2,
      "provider": "qwen_ai_platform",
      "sourceUrl": "https://www.alibabacloud.com/help/en/model-studio/models"
    },
    "qwen_ai_platform/qwen-plus-2025-01-25": {
      "inputUsdPerMillion": 0.39999999999999997,
      "outputUsdPerMillion": 1.2,
      "provider": "qwen_ai_platform",
      "sourceUrl": "https://www.alibabacloud.com/help/en/model-studio/models"
    },
    "qwen_ai_platform/qwen-plus-2025-04-28": {
      "inputUsdPerMillion": 0.39999999999999997,
      "outputUsdPerMillion": 1.2,
      "reasoningUsdPerMillion": 4,
      "provider": "qwen_ai_platform",
      "sourceUrl": "https://www.alibabacloud.com/help/en/model-studio/models"
    },
    "qwen_ai_platform/qwen-plus-2025-07-14": {
      "inputUsdPerMillion": 0.39999999999999997,
      "outputUsdPerMillion": 1.2,
      "reasoningUsdPerMillion": 4,
      "provider": "qwen_ai_platform",
      "sourceUrl": "https://www.alibabacloud.com/help/en/model-studio/models"
    },
    "qwen_ai_platform/qwen-turbo": {
      "inputUsdPerMillion": 0.049999999999999996,
      "outputUsdPerMillion": 0.19999999999999998,
      "reasoningUsdPerMillion": 0.5,
      "provider": "qwen_ai_platform",
      "sourceUrl": "https://www.alibabacloud.com/help/en/model-studio/models"
    },
    "qwen_ai_platform/qwen-turbo-2024-11-01": {
      "inputUsdPerMillion": 0.049999999999999996,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "qwen_ai_platform",
      "sourceUrl": "https://www.alibabacloud.com/help/en/model-studio/models"
    },
    "qwen_ai_platform/qwen-turbo-2025-04-28": {
      "inputUsdPerMillion": 0.049999999999999996,
      "outputUsdPerMillion": 0.19999999999999998,
      "reasoningUsdPerMillion": 0.5,
      "provider": "qwen_ai_platform",
      "sourceUrl": "https://www.alibabacloud.com/help/en/model-studio/models"
    },
    "qwen_ai_platform/qwen-turbo-latest": {
      "inputUsdPerMillion": 0.049999999999999996,
      "outputUsdPerMillion": 0.19999999999999998,
      "reasoningUsdPerMillion": 0.5,
      "provider": "qwen_ai_platform",
      "sourceUrl": "https://www.alibabacloud.com/help/en/model-studio/models"
    },
    "qwen_ai_platform/qwen3-next-80b-a3b-instruct": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 1.2,
      "provider": "qwen_ai_platform",
      "sourceUrl": "https://www.alibabacloud.com/help/en/model-studio/model-pricing"
    },
    "qwen_ai_platform/qwen3-next-80b-a3b-thinking": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 1.2,
      "provider": "qwen_ai_platform",
      "sourceUrl": "https://www.alibabacloud.com/help/en/model-studio/model-pricing"
    },
    "qwen_ai_platform/qwen3-vl-235b-a22b-instruct": {
      "inputUsdPerMillion": 0.39999999999999997,
      "outputUsdPerMillion": 1.5999999999999999,
      "provider": "qwen_ai_platform",
      "sourceUrl": "https://www.alibabacloud.com/help/en/model-studio/model-pricing"
    },
    "qwen_ai_platform/qwen3-vl-235b-a22b-thinking": {
      "inputUsdPerMillion": 0.39999999999999997,
      "outputUsdPerMillion": 4,
      "provider": "qwen_ai_platform",
      "sourceUrl": "https://www.alibabacloud.com/help/en/model-studio/model-pricing"
    },
    "qwen_ai_platform/qwen3-vl-32b-instruct": {
      "inputUsdPerMillion": 0.16,
      "outputUsdPerMillion": 0.64,
      "provider": "qwen_ai_platform",
      "sourceUrl": "https://www.alibabacloud.com/help/en/model-studio/model-pricing"
    },
    "qwen_ai_platform/qwen3-vl-32b-thinking": {
      "inputUsdPerMillion": 0.16,
      "outputUsdPerMillion": 2.87,
      "provider": "qwen_ai_platform",
      "sourceUrl": "https://www.alibabacloud.com/help/en/model-studio/model-pricing"
    },
    "qwen_ai_platform/qwen3.7-max": {
      "inputUsdPerMillion": 2.5,
      "outputUsdPerMillion": 7.5,
      "cacheReadUsdPerMillion": 0.5,
      "provider": "qwen_ai_platform",
      "sourceUrl": "https://www.alibabacloud.com/help/en/model-studio/models"
    },
    "qwen_ai_platform/qwen3.8-max": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 6,
      "cacheReadUsdPerMillion": 0.25,
      "provider": "qwen_ai_platform",
      "sourceUrl": "https://www.alibabacloud.com/help/en/model-studio/models"
    },
    "qwen_ai_platform/qwen3.8-flash": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.47,
      "cacheReadUsdPerMillion": 0.016,
      "cacheWriteUsdPerMillion": 0.19999999999999998,
      "provider": "qwen_ai_platform",
      "sourceUrl": "https://docs.modelstudio.console.alibabacloud.com/en/model-studio/model-pricing"
    },
    "qwen_ai_platform/qwen3.8-omni-flash": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.47,
      "cacheReadUsdPerMillion": 0.016,
      "provider": "qwen_ai_platform",
      "sourceUrl": "https://docs.modelstudio.console.alibabacloud.com/en/model-studio/model-pricing"
    },
    "qwen_ai_platform/qwq-plus": {
      "inputUsdPerMillion": 0.7999999999999999,
      "outputUsdPerMillion": 2.4,
      "provider": "qwen_ai_platform",
      "sourceUrl": "https://www.alibabacloud.com/help/en/model-studio/models"
    },
    "databricks/databricks-claude-fable-5": {
      "inputUsdPerMillion": 10.00006,
      "outputUsdPerMillion": 50.00002,
      "cacheReadUsdPerMillion": 1.0000200000000001,
      "cacheWriteUsdPerMillion": 12.50004,
      "provider": "databricks",
      "sourceUrl": "https://www.databricks.com/product/pricing/proprietary-foundation-model-serving"
    },
    "databricks/databricks-claude-fable-5-1": {
      "inputUsdPerMillion": 10.00006,
      "outputUsdPerMillion": 50.00002,
      "cacheReadUsdPerMillion": 0.25004,
      "cacheWriteUsdPerMillion": 12.50004,
      "provider": "databricks",
      "sourceUrl": "https://www.databricks.com/product/pricing/proprietary-foundation-model-serving"
    },
    "databricks/databricks-claude-haiku-4-5": {
      "inputUsdPerMillion": 1.0000200000000001,
      "outputUsdPerMillion": 5.00003,
      "cacheReadUsdPerMillion": 0.10003000000000001,
      "cacheWriteUsdPerMillion": 1.24999,
      "provider": "databricks",
      "sourceUrl": "https://www.databricks.com/product/pricing/proprietary-foundation-model-serving"
    },
    "databricks/databricks-claude-opus-4": {
      "inputUsdPerMillion": 15.000020000000001,
      "outputUsdPerMillion": 75.00003000000001,
      "cacheReadUsdPerMillion": 1.50003,
      "cacheWriteUsdPerMillion": 18.74999,
      "provider": "databricks",
      "sourceUrl": "https://www.databricks.com/product/pricing/proprietary-foundation-model-serving"
    },
    "databricks/databricks-claude-opus-4-1": {
      "inputUsdPerMillion": 15.000020000000001,
      "outputUsdPerMillion": 75.00003000000001,
      "cacheReadUsdPerMillion": 1.50003,
      "cacheWriteUsdPerMillion": 18.74999,
      "provider": "databricks",
      "sourceUrl": "https://www.databricks.com/product/pricing/proprietary-foundation-model-serving"
    },
    "databricks/databricks-claude-opus-4-5": {
      "inputUsdPerMillion": 5.00003,
      "outputUsdPerMillion": 25.000010000000003,
      "cacheReadUsdPerMillion": 0.5000100000000001,
      "cacheWriteUsdPerMillion": 6.25002,
      "provider": "databricks",
      "sourceUrl": "https://www.databricks.com/product/pricing/proprietary-foundation-model-serving"
    },
    "databricks/databricks-claude-opus-4-6": {
      "inputUsdPerMillion": 5.00003,
      "outputUsdPerMillion": 25.000010000000003,
      "cacheReadUsdPerMillion": 0.5000100000000001,
      "cacheWriteUsdPerMillion": 6.25002,
      "provider": "databricks",
      "sourceUrl": "https://www.databricks.com/product/pricing/proprietary-foundation-model-serving"
    },
    "databricks/databricks-claude-opus-4-7": {
      "inputUsdPerMillion": 5.00003,
      "outputUsdPerMillion": 25.00001,
      "cacheReadUsdPerMillion": 0.5000100000000001,
      "cacheWriteUsdPerMillion": 6.25002,
      "provider": "databricks",
      "sourceUrl": "https://www.databricks.com/product/pricing/proprietary-foundation-model-serving"
    },
    "databricks/databricks-claude-opus-4-8": {
      "inputUsdPerMillion": 5.00003,
      "outputUsdPerMillion": 25.00001,
      "cacheReadUsdPerMillion": 0.5000100000000001,
      "cacheWriteUsdPerMillion": 6.25002,
      "provider": "databricks",
      "sourceUrl": "https://www.databricks.com/product/pricing/proprietary-foundation-model-serving"
    },
    "databricks/databricks-claude-opus-5": {
      "inputUsdPerMillion": 5.00003,
      "outputUsdPerMillion": 25.00001,
      "cacheReadUsdPerMillion": 0.5000100000000001,
      "cacheWriteUsdPerMillion": 6.25002,
      "provider": "databricks",
      "sourceUrl": "https://www.databricks.com/product/pricing/proprietary-foundation-model-serving"
    },
    "databricks/databricks-claude-opus-5-5": {
      "inputUsdPerMillion": 4.00001,
      "outputUsdPerMillion": 19.99998,
      "cacheReadUsdPerMillion": 0.19999,
      "cacheWriteUsdPerMillion": 5.00003,
      "provider": "databricks",
      "sourceUrl": "https://www.databricks.com/product/pricing/proprietary-foundation-model-serving"
    },
    "databricks/databricks-claude-sonnet-4": {
      "inputUsdPerMillion": 2.9999900000000004,
      "outputUsdPerMillion": 15.000020000000001,
      "cacheReadUsdPerMillion": 0.30002,
      "cacheWriteUsdPerMillion": 3.7499700000000002,
      "provider": "databricks",
      "sourceUrl": "https://www.databricks.com/product/pricing/proprietary-foundation-model-serving"
    },
    "databricks/databricks-claude-sonnet-4-1": {
      "inputUsdPerMillion": 2.9999900000000004,
      "outputUsdPerMillion": 15.000020000000001,
      "cacheReadUsdPerMillion": 0.30002,
      "cacheWriteUsdPerMillion": 3.7499700000000002,
      "provider": "databricks",
      "sourceUrl": "https://www.databricks.com/product/pricing/proprietary-foundation-model-serving"
    },
    "databricks/databricks-claude-sonnet-4-5": {
      "inputUsdPerMillion": 2.9999900000000004,
      "outputUsdPerMillion": 15.000020000000001,
      "cacheReadUsdPerMillion": 0.30002,
      "cacheWriteUsdPerMillion": 3.7499700000000002,
      "provider": "databricks",
      "sourceUrl": "https://www.databricks.com/product/pricing/proprietary-foundation-model-serving"
    },
    "databricks/databricks-claude-sonnet-4-6": {
      "inputUsdPerMillion": 2.9999900000000004,
      "outputUsdPerMillion": 15.000020000000001,
      "cacheReadUsdPerMillion": 0.30002,
      "cacheWriteUsdPerMillion": 3.7499700000000002,
      "provider": "databricks",
      "sourceUrl": "https://www.databricks.com/product/pricing/proprietary-foundation-model-serving"
    },
    "databricks/databricks-claude-sonnet-5": {
      "inputUsdPerMillion": 2.99999,
      "outputUsdPerMillion": 15.00002,
      "cacheReadUsdPerMillion": 0.30002,
      "cacheWriteUsdPerMillion": 3.7499700000000002,
      "provider": "databricks",
      "sourceUrl": "https://www.databricks.com/product/pricing/proprietary-foundation-model-serving"
    },
    "databricks/databricks-deepseek-v4-flash-0731": {
      "inputUsdPerMillion": 0.14,
      "outputUsdPerMillion": 0.28,
      "cacheReadUsdPerMillion": 0.028,
      "cacheWriteUsdPerMillion": 0.14,
      "provider": "databricks",
      "sourceUrl": "https://www.databricks.com/product/pricing/foundation-model-serving"
    },
    "databricks/databricks-deepseek-v4-pro-0813": {
      "inputUsdPerMillion": 1.31999,
      "outputUsdPerMillion": 3.9599699999999998,
      "cacheReadUsdPerMillion": 0.13202,
      "cacheWriteUsdPerMillion": 1.31999,
      "provider": "databricks",
      "sourceUrl": "https://www.databricks.com/product/pricing/foundation-model-serving"
    },
    "databricks/databricks-gemini-2-5-flash": {
      "inputUsdPerMillion": 0.30001999999999995,
      "outputUsdPerMillion": 2.49998,
      "cacheReadUsdPerMillion": 0.030002,
      "cacheWriteUsdPerMillion": 0.30002,
      "provider": "databricks",
      "sourceUrl": "https://www.databricks.com/product/pricing/proprietary-foundation-model-serving"
    },
    "databricks/databricks-gemini-2-5-pro": {
      "inputUsdPerMillion": 1.24999,
      "outputUsdPerMillion": 9.999990000000002,
      "cacheReadUsdPerMillion": 0.124999,
      "cacheWriteUsdPerMillion": 1.24999,
      "provider": "databricks",
      "sourceUrl": "https://www.databricks.com/product/pricing/proprietary-foundation-model-serving"
    },
    "databricks/databricks-gemini-3-1-flash-lite": {
      "inputUsdPerMillion": 0.31248,
      "outputUsdPerMillion": 1.87502,
      "cacheReadUsdPerMillion": 0.031219999999999998,
      "cacheWriteUsdPerMillion": 0.31248,
      "provider": "databricks",
      "sourceUrl": "https://www.databricks.com/product/pricing/proprietary-foundation-model-serving"
    },
    "databricks/databricks-gemini-3-1-pro": {
      "inputUsdPerMillion": 2.49998,
      "outputUsdPerMillion": 15.000020000000001,
      "cacheReadUsdPerMillion": 0.24997,
      "cacheWriteUsdPerMillion": 2.49998,
      "provider": "databricks",
      "sourceUrl": "https://www.databricks.com/product/pricing/proprietary-foundation-model-serving"
    },
    "databricks/databricks-gemini-3-flash": {
      "inputUsdPerMillion": 0.6250300000000001,
      "outputUsdPerMillion": 3.7499700000000002,
      "cacheReadUsdPerMillion": 0.06251,
      "cacheWriteUsdPerMillion": 0.6250300000000001,
      "provider": "databricks",
      "sourceUrl": "https://www.databricks.com/product/pricing/proprietary-foundation-model-serving"
    },
    "databricks/databricks-gemini-3-pro": {
      "inputUsdPerMillion": 2.49998,
      "outputUsdPerMillion": 15.000020000000001,
      "cacheReadUsdPerMillion": 0.24997,
      "cacheWriteUsdPerMillion": 2.49998,
      "provider": "databricks",
      "sourceUrl": "https://www.databricks.com/product/pricing/proprietary-foundation-model-serving"
    },
    "databricks/databricks-gemini-3-6-flash": {
      "inputUsdPerMillion": 1.87502,
      "outputUsdPerMillion": 9.375029999999999,
      "cacheReadUsdPerMillion": 0.18753,
      "cacheWriteUsdPerMillion": 1.87502,
      "provider": "databricks",
      "sourceUrl": "https://www.databricks.com/product/pricing/proprietary-foundation-model-serving"
    },
    "databricks/databricks-gemini-3-5-flash": {
      "inputUsdPerMillion": 1.87502,
      "outputUsdPerMillion": 11.249979999999999,
      "cacheReadUsdPerMillion": 0.18753,
      "cacheWriteUsdPerMillion": 1.87502,
      "provider": "databricks",
      "sourceUrl": "https://www.databricks.com/product/pricing/proprietary-foundation-model-serving"
    },
    "databricks/databricks-gemini-3-5-flash-lite": {
      "inputUsdPerMillion": 0.37499,
      "outputUsdPerMillion": 3.12501,
      "cacheReadUsdPerMillion": 0.03752,
      "cacheWriteUsdPerMillion": 0.37499,
      "provider": "databricks",
      "sourceUrl": "https://www.databricks.com/product/pricing/proprietary-foundation-model-serving"
    },
    "databricks/databricks-gemma-3-12b": {
      "inputUsdPerMillion": 0.15000999999999998,
      "outputUsdPerMillion": 0.5000100000000001,
      "cacheReadUsdPerMillion": 0.15001,
      "cacheWriteUsdPerMillion": 0.15001,
      "provider": "databricks",
      "sourceUrl": "https://www.databricks.com/product/pricing/foundation-model-serving"
    },
    "databricks/databricks-glm-5-2": {
      "inputUsdPerMillion": 1.4,
      "outputUsdPerMillion": 4.399990000000001,
      "cacheReadUsdPerMillion": 0.25998,
      "cacheWriteUsdPerMillion": 1.4,
      "provider": "databricks",
      "sourceUrl": "https://www.databricks.com/product/pricing/foundation-model-serving"
    },
    "databricks/databricks-glm-5-3": {
      "inputUsdPerMillion": 1.4,
      "outputUsdPerMillion": 4.399990000000001,
      "cacheReadUsdPerMillion": 0.25998,
      "cacheWriteUsdPerMillion": 1.4,
      "provider": "databricks",
      "sourceUrl": "https://www.databricks.com/product/pricing/foundation-model-serving"
    },
    "databricks/databricks-glm-5-3-flash": {
      "inputUsdPerMillion": 0.15001,
      "outputUsdPerMillion": 0.5000100000000001,
      "cacheReadUsdPerMillion": 0.030029999999999998,
      "cacheWriteUsdPerMillion": 0.15001,
      "provider": "databricks",
      "sourceUrl": "https://www.databricks.com/product/pricing/foundation-model-serving"
    },
    "databricks/databricks-gpt-5": {
      "inputUsdPerMillion": 1.24999,
      "outputUsdPerMillion": 9.999990000000002,
      "cacheReadUsdPerMillion": 0.12502,
      "cacheWriteUsdPerMillion": 1.24999,
      "provider": "databricks",
      "sourceUrl": "https://www.databricks.com/product/pricing/proprietary-foundation-model-serving"
    },
    "databricks/databricks-gpt-5-1": {
      "inputUsdPerMillion": 1.24999,
      "outputUsdPerMillion": 9.999990000000002,
      "cacheReadUsdPerMillion": 0.12502,
      "cacheWriteUsdPerMillion": 1.24999,
      "provider": "databricks",
      "sourceUrl": "https://www.databricks.com/product/pricing/proprietary-foundation-model-serving"
    },
    "databricks/databricks-gpt-5-2": {
      "inputUsdPerMillion": 1.75,
      "outputUsdPerMillion": 14,
      "cacheReadUsdPerMillion": 0.175,
      "cacheWriteUsdPerMillion": 1.75,
      "provider": "databricks",
      "sourceUrl": "https://www.databricks.com/product/pricing/proprietary-foundation-model-serving"
    },
    "databricks/databricks-gpt-5-4": {
      "inputUsdPerMillion": 2.49998,
      "outputUsdPerMillion": 15.000020000000001,
      "cacheReadUsdPerMillion": 0.24997,
      "cacheWriteUsdPerMillion": 2.49998,
      "provider": "databricks",
      "sourceUrl": "https://www.databricks.com/product/pricing/proprietary-foundation-model-serving"
    },
    "databricks/databricks-gpt-5-4-mini": {
      "inputUsdPerMillion": 0.74998,
      "outputUsdPerMillion": 4.50002,
      "cacheReadUsdPerMillion": 0.07497000000000001,
      "cacheWriteUsdPerMillion": 0.74998,
      "provider": "databricks",
      "sourceUrl": "https://www.databricks.com/product/pricing/proprietary-foundation-model-serving"
    },
    "databricks/databricks-gpt-5-4-nano": {
      "inputUsdPerMillion": 0.19999,
      "outputUsdPerMillion": 1.24999,
      "cacheReadUsdPerMillion": 0.02002,
      "cacheWriteUsdPerMillion": 0.19999,
      "provider": "databricks",
      "sourceUrl": "https://www.databricks.com/product/pricing/proprietary-foundation-model-serving"
    },
    "databricks/databricks-gpt-5-6-sol": {
      "inputUsdPerMillion": 4.00001,
      "outputUsdPerMillion": 19.99998,
      "cacheReadUsdPerMillion": 0.39998,
      "cacheWriteUsdPerMillion": 5.00003,
      "provider": "databricks",
      "sourceUrl": "https://www.databricks.com/product/pricing/proprietary-foundation-model-serving"
    },
    "databricks/databricks-gpt-5-6-terra": {
      "inputUsdPerMillion": 2.49998,
      "outputUsdPerMillion": 15.00002,
      "cacheReadUsdPerMillion": 0.24997,
      "cacheWriteUsdPerMillion": 3.12501,
      "provider": "databricks",
      "sourceUrl": "https://www.databricks.com/product/pricing/proprietary-foundation-model-serving"
    },
    "databricks/databricks-gpt-5-6-luna": {
      "inputUsdPerMillion": 1.0000200000000001,
      "outputUsdPerMillion": 5.99998,
      "cacheReadUsdPerMillion": 0.10003000000000001,
      "cacheWriteUsdPerMillion": 1.24999,
      "provider": "databricks",
      "sourceUrl": "https://www.databricks.com/product/pricing/proprietary-foundation-model-serving"
    },
    "databricks/databricks-gpt-5-mini": {
      "inputUsdPerMillion": 0.24997000000000005,
      "outputUsdPerMillion": 1.9999700000000002,
      "cacheReadUsdPerMillion": 0.024990000000000002,
      "cacheWriteUsdPerMillion": 0.24997,
      "provider": "databricks",
      "sourceUrl": "https://www.databricks.com/product/pricing/proprietary-foundation-model-serving"
    },
    "databricks/databricks-gpt-5-nano": {
      "inputUsdPerMillion": 0.049980000000000004,
      "outputUsdPerMillion": 0.39998000000000006,
      "cacheReadUsdPerMillion": 0.00497,
      "cacheWriteUsdPerMillion": 0.049980000000000004,
      "provider": "databricks",
      "sourceUrl": "https://www.databricks.com/product/pricing/proprietary-foundation-model-serving"
    },
    "databricks/databricks-gpt-oss-120b": {
      "inputUsdPerMillion": 0.15000999999999998,
      "outputUsdPerMillion": 0.59997,
      "cacheReadUsdPerMillion": 0.15001,
      "cacheWriteUsdPerMillion": 0.15001,
      "provider": "databricks",
      "sourceUrl": "https://www.databricks.com/product/pricing/foundation-model-serving"
    },
    "databricks/databricks-gpt-oss-20b": {
      "inputUsdPerMillion": 0.07,
      "outputUsdPerMillion": 0.30001999999999995,
      "cacheReadUsdPerMillion": 0.07,
      "cacheWriteUsdPerMillion": 0.07,
      "provider": "databricks",
      "sourceUrl": "https://www.databricks.com/product/pricing/foundation-model-serving"
    },
    "databricks/databricks-grok-4-6": {
      "inputUsdPerMillion": 2.49998,
      "outputUsdPerMillion": 7.50001,
      "cacheReadUsdPerMillion": 0.6250300000000001,
      "cacheWriteUsdPerMillion": 2.49998,
      "provider": "databricks",
      "sourceUrl": "https://www.databricks.com/product/pricing/proprietary-foundation-model-serving"
    },
    "databricks/databricks-inkling": {
      "inputUsdPerMillion": 1.0000200000000001,
      "outputUsdPerMillion": 4.04999,
      "cacheReadUsdPerMillion": 0.17003,
      "cacheWriteUsdPerMillion": 1.0000200000000001,
      "provider": "databricks",
      "sourceUrl": "https://www.databricks.com/product/pricing/foundation-model-serving"
    },
    "databricks/databricks-kimi-k3": {
      "inputUsdPerMillion": 2.99999,
      "outputUsdPerMillion": 15.00002,
      "cacheReadUsdPerMillion": 0.30002,
      "cacheWriteUsdPerMillion": 2.99999,
      "provider": "databricks",
      "sourceUrl": "https://www.databricks.com/product/pricing/foundation-model-serving"
    },
    "databricks/databricks-llama-4-maverick": {
      "inputUsdPerMillion": 0.5000100000000001,
      "outputUsdPerMillion": 1.5000300000000002,
      "cacheReadUsdPerMillion": 0.5000100000000001,
      "cacheWriteUsdPerMillion": 0.5000100000000001,
      "provider": "databricks",
      "sourceUrl": "https://www.databricks.com/product/pricing/foundation-model-serving"
    },
    "databricks/databricks-meta-llama-3-1-8b-instruct": {
      "inputUsdPerMillion": 0.15000999999999998,
      "outputUsdPerMillion": 0.45003000000000004,
      "cacheReadUsdPerMillion": 0.15001,
      "cacheWriteUsdPerMillion": 0.15001,
      "provider": "databricks",
      "sourceUrl": "https://www.databricks.com/product/pricing/foundation-model-serving"
    },
    "databricks/databricks-meta-llama-3-3-70b-instruct": {
      "inputUsdPerMillion": 0.5000100000000001,
      "outputUsdPerMillion": 1.5000300000000002,
      "cacheReadUsdPerMillion": 0.5000100000000001,
      "cacheWriteUsdPerMillion": 0.5000100000000001,
      "provider": "databricks",
      "sourceUrl": "https://www.databricks.com/product/pricing/foundation-model-serving"
    },
    "databricks/databricks-qwen35-122b-a10b": {
      "inputUsdPerMillion": 0.22000999999999998,
      "outputUsdPerMillion": 2.20003,
      "cacheReadUsdPerMillion": 0.22000999999999998,
      "cacheWriteUsdPerMillion": 0.22000999999999998,
      "provider": "databricks",
      "sourceUrl": "https://www.databricks.com/product/pricing/foundation-model-serving"
    },
    "databricks/databricks-qwen3-next-80b-a3b-instruct": {
      "inputUsdPerMillion": 0.15001,
      "outputUsdPerMillion": 1.20001,
      "cacheReadUsdPerMillion": 0.15001,
      "cacheWriteUsdPerMillion": 0.15001,
      "provider": "databricks",
      "sourceUrl": "https://www.databricks.com/product/pricing/foundation-model-serving"
    },
    "davinci-002": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 2,
      "provider": "text-completion-openai",
      "sourceUrl": "https://developers.openai.com/api/docs/pricing"
    },
    "deepinfra/Gryphe/MythoMax-L2-13b": {
      "inputUsdPerMillion": 0.39999999999999997,
      "outputUsdPerMillion": 0.39999999999999997,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/NousResearch/Hermes-3-Llama-3.1-405B": {
      "inputUsdPerMillion": 1,
      "outputUsdPerMillion": 1,
      "provider": "deepinfra"
    },
    "deepinfra/NousResearch/Hermes-3-Llama-3.1-70B": {
      "inputUsdPerMillion": 0.7,
      "outputUsdPerMillion": 0.7,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/Qwen/QwQ-32B": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.39999999999999997,
      "provider": "deepinfra"
    },
    "deepinfra/Qwen/Qwen2.5-72B-Instruct": {
      "inputUsdPerMillion": 0.36,
      "outputUsdPerMillion": 0.39999999999999997,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/Qwen/Qwen2.5-7B-Instruct": {
      "inputUsdPerMillion": 0.04,
      "outputUsdPerMillion": 0.09999999999999999,
      "provider": "deepinfra"
    },
    "deepinfra/Qwen/Qwen2.5-VL-32B-Instruct": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.6,
      "provider": "deepinfra"
    },
    "deepinfra/Qwen/Qwen3-14B": {
      "inputUsdPerMillion": 0.12,
      "outputUsdPerMillion": 0.24,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/Qwen/Qwen3-235B-A22B": {
      "inputUsdPerMillion": 0.18,
      "outputUsdPerMillion": 0.54,
      "provider": "deepinfra"
    },
    "deepinfra/Qwen/Qwen3-235B-A22B-Instruct-2507": {
      "inputUsdPerMillion": 0.09,
      "outputUsdPerMillion": 0.55,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/Qwen/Qwen3-235B-A22B-Thinking-2507": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 2.9000000000000004,
      "provider": "deepinfra"
    },
    "deepinfra/Qwen/Qwen3-30B-A3B": {
      "inputUsdPerMillion": 0.12,
      "outputUsdPerMillion": 0.5,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/Qwen/Qwen3-32B": {
      "inputUsdPerMillion": 0.08,
      "outputUsdPerMillion": 0.28,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/Qwen/Qwen3-Coder-480B-A35B-Instruct": {
      "inputUsdPerMillion": 0.39999999999999997,
      "outputUsdPerMillion": 1.5999999999999999,
      "provider": "deepinfra"
    },
    "deepinfra/Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 1,
      "cacheReadUsdPerMillion": 0.09999999999999999,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/Qwen/Qwen3-Next-80B-A3B-Instruct": {
      "inputUsdPerMillion": 0.09,
      "outputUsdPerMillion": 1.1,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/Qwen/Qwen3-Next-80B-A3B-Thinking": {
      "inputUsdPerMillion": 0.14,
      "outputUsdPerMillion": 1.4,
      "provider": "deepinfra"
    },
    "deepinfra/Sao10K/L3-8B-Lunaris-v1-Turbo": {
      "inputUsdPerMillion": 0.04,
      "outputUsdPerMillion": 0.049999999999999996,
      "provider": "deepinfra"
    },
    "deepinfra/Sao10K/L3.1-70B-Euryale-v2.2": {
      "inputUsdPerMillion": 0.85,
      "outputUsdPerMillion": 0.85,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/Sao10K/L3.3-70B-Euryale-v2.3": {
      "inputUsdPerMillion": 0.65,
      "outputUsdPerMillion": 0.75,
      "provider": "deepinfra"
    },
    "deepinfra/allenai/olmOCR-7B-0725-FP8": {
      "inputUsdPerMillion": 0.27,
      "outputUsdPerMillion": 1.5,
      "provider": "deepinfra"
    },
    "deepinfra/anthropic/claude-3-7-sonnet-latest": {
      "inputUsdPerMillion": 3.3000000000000003,
      "outputUsdPerMillion": 16.5,
      "cacheReadUsdPerMillion": 0.33,
      "provider": "deepinfra"
    },
    "deepinfra/anthropic/claude-4-opus": {
      "inputUsdPerMillion": 16.5,
      "outputUsdPerMillion": 82.5,
      "provider": "deepinfra"
    },
    "deepinfra/anthropic/claude-4-sonnet": {
      "inputUsdPerMillion": 3.3000000000000003,
      "outputUsdPerMillion": 16.5,
      "provider": "deepinfra"
    },
    "deepinfra/deepseek-ai/DeepSeek-R1": {
      "inputUsdPerMillion": 0.7,
      "outputUsdPerMillion": 2.4,
      "provider": "deepinfra"
    },
    "deepinfra/deepseek-ai/DeepSeek-R1-0528": {
      "inputUsdPerMillion": 0.5,
      "outputUsdPerMillion": 2.1500000000000004,
      "cacheReadUsdPerMillion": 0.39999999999999997,
      "provider": "deepinfra"
    },
    "deepinfra/deepseek-ai/DeepSeek-R1-0528-Turbo": {
      "inputUsdPerMillion": 1,
      "outputUsdPerMillion": 3,
      "provider": "deepinfra"
    },
    "deepinfra/deepseek-ai/DeepSeek-R1-Distill-Llama-70B": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.6,
      "provider": "deepinfra"
    },
    "deepinfra/deepseek-ai/DeepSeek-R1-Distill-Qwen-32B": {
      "inputUsdPerMillion": 0.27,
      "outputUsdPerMillion": 0.27,
      "provider": "deepinfra"
    },
    "deepinfra/deepseek-ai/DeepSeek-R1-Turbo": {
      "inputUsdPerMillion": 1,
      "outputUsdPerMillion": 3,
      "provider": "deepinfra"
    },
    "deepinfra/deepseek-ai/DeepSeek-V3": {
      "inputUsdPerMillion": 0.32,
      "outputUsdPerMillion": 0.8899999999999999,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/deepseek-ai/DeepSeek-V3-0324": {
      "inputUsdPerMillion": 0.24,
      "outputUsdPerMillion": 0.8999999999999999,
      "cacheReadUsdPerMillion": 0.135,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/deepseek-ai/DeepSeek-V3.1": {
      "inputUsdPerMillion": 0.25,
      "outputUsdPerMillion": 0.95,
      "cacheReadUsdPerMillion": 0.216,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/deepseek-ai/DeepSeek-V3.1-Terminus": {
      "inputUsdPerMillion": 0.27,
      "outputUsdPerMillion": 1,
      "cacheReadUsdPerMillion": 0.216,
      "provider": "deepinfra"
    },
    "deepinfra/google/gemini-2.5-flash": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 2.5,
      "provider": "deepinfra"
    },
    "deepinfra/google/gemini-2.5-pro": {
      "inputUsdPerMillion": 1.25,
      "outputUsdPerMillion": 10,
      "provider": "deepinfra"
    },
    "deepinfra/google/gemma-3-12b-it": {
      "inputUsdPerMillion": 0.049999999999999996,
      "outputUsdPerMillion": 0.15,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/google/gemma-3-27b-it": {
      "inputUsdPerMillion": 0.08,
      "outputUsdPerMillion": 0.16,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/google/gemma-3-4b-it": {
      "inputUsdPerMillion": 0.049999999999999996,
      "outputUsdPerMillion": 0.09999999999999999,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/meta-llama/Llama-3.2-11B-Vision-Instruct": {
      "inputUsdPerMillion": 0.049,
      "outputUsdPerMillion": 0.049,
      "provider": "deepinfra"
    },
    "deepinfra/meta-llama/Llama-3.2-3B-Instruct": {
      "inputUsdPerMillion": 0.02,
      "outputUsdPerMillion": 0.02,
      "provider": "deepinfra"
    },
    "deepinfra/meta-llama/Llama-3.3-70B-Instruct": {
      "inputUsdPerMillion": 0.22999999999999998,
      "outputUsdPerMillion": 0.39999999999999997,
      "provider": "deepinfra"
    },
    "deepinfra/meta-llama/Llama-3.3-70B-Instruct-Turbo": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.32,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.7999999999999999,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/meta-llama/Llama-4-Scout-17B-16E-Instruct": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.3,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/meta-llama/Llama-Guard-3-8B": {
      "inputUsdPerMillion": 0.055,
      "outputUsdPerMillion": 0.055,
      "provider": "deepinfra"
    },
    "deepinfra/meta-llama/Llama-Guard-4-12B": {
      "inputUsdPerMillion": 0.18,
      "outputUsdPerMillion": 0.18,
      "provider": "deepinfra"
    },
    "deepinfra/meta-llama/Meta-Llama-3-8B-Instruct": {
      "inputUsdPerMillion": 0.03,
      "outputUsdPerMillion": 0.06,
      "provider": "deepinfra"
    },
    "deepinfra/meta-llama/Meta-Llama-3.1-70B-Instruct": {
      "inputUsdPerMillion": 0.39999999999999997,
      "outputUsdPerMillion": 0.39999999999999997,
      "provider": "deepinfra"
    },
    "deepinfra/meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo": {
      "inputUsdPerMillion": 0.39999999999999997,
      "outputUsdPerMillion": 0.39999999999999997,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/meta-llama/Meta-Llama-3.1-8B-Instruct": {
      "inputUsdPerMillion": 0.03,
      "outputUsdPerMillion": 0.049999999999999996,
      "provider": "deepinfra"
    },
    "deepinfra/meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo": {
      "inputUsdPerMillion": 0.02,
      "outputUsdPerMillion": 0.04,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/microsoft/WizardLM-2-8x22B": {
      "inputUsdPerMillion": 0.48,
      "outputUsdPerMillion": 0.48,
      "provider": "deepinfra"
    },
    "deepinfra/microsoft/phi-4": {
      "inputUsdPerMillion": 0.07,
      "outputUsdPerMillion": 0.14,
      "provider": "deepinfra"
    },
    "deepinfra/mistralai/Mistral-Nemo-Instruct-2407": {
      "inputUsdPerMillion": 0.019000000000000003,
      "outputUsdPerMillion": 0.03,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/mistralai/Mistral-Small-24B-Instruct-2501": {
      "inputUsdPerMillion": 0.049999999999999996,
      "outputUsdPerMillion": 0.08,
      "provider": "deepinfra"
    },
    "deepinfra/mistralai/Mistral-Small-3.2-24B-Instruct-2506": {
      "inputUsdPerMillion": 0.075,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "deepinfra"
    },
    "deepinfra/mistralai/Mixtral-8x7B-Instruct-v0.1": {
      "inputUsdPerMillion": 0.39999999999999997,
      "outputUsdPerMillion": 0.39999999999999997,
      "provider": "deepinfra"
    },
    "deepinfra/moonshotai/Kimi-K2-Instruct": {
      "inputUsdPerMillion": 0.5,
      "outputUsdPerMillion": 2,
      "provider": "deepinfra"
    },
    "deepinfra/moonshotai/Kimi-K2-Instruct-0905": {
      "inputUsdPerMillion": 0.5,
      "outputUsdPerMillion": 2,
      "cacheReadUsdPerMillion": 0.39999999999999997,
      "provider": "deepinfra"
    },
    "deepinfra/nvidia/Llama-3.1-Nemotron-70B-Instruct": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 0.6,
      "provider": "deepinfra"
    },
    "deepinfra/nvidia/Llama-3.3-Nemotron-Super-49B-v1.5": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.39999999999999997,
      "provider": "deepinfra"
    },
    "deepinfra/nvidia/NVIDIA-Nemotron-3.5-Lightning": {
      "inputUsdPerMillion": 0.08,
      "outputUsdPerMillion": 0.19999999999999998,
      "cacheReadUsdPerMillion": 0.04,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/nvidia/NVIDIA-Nemotron-Nano-9B-v2": {
      "inputUsdPerMillion": 0.04,
      "outputUsdPerMillion": 0.16,
      "provider": "deepinfra"
    },
    "deepinfra/openai/gpt-oss-120b": {
      "inputUsdPerMillion": 0.037,
      "outputUsdPerMillion": 0.16999999999999998,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/openai/gpt-oss-20b": {
      "inputUsdPerMillion": 0.03,
      "outputUsdPerMillion": 0.14,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/zai-org/GLM-4.5": {
      "inputUsdPerMillion": 0.39999999999999997,
      "outputUsdPerMillion": 1.5999999999999999,
      "provider": "deepinfra"
    },
    "deepseek/deepseek-chat": {
      "inputUsdPerMillion": 0.28,
      "outputUsdPerMillion": 0.42,
      "cacheReadUsdPerMillion": 0.028,
      "cacheWriteUsdPerMillion": 0,
      "provider": "deepseek",
      "sourceUrl": "https://api-docs.deepseek.com/quick_start/pricing"
    },
    "deepseek/deepseek-coder": {
      "inputUsdPerMillion": 0.14,
      "outputUsdPerMillion": 0.28,
      "cacheReadUsdPerMillion": 0.014,
      "provider": "deepseek"
    },
    "deepseek/deepseek-r1": {
      "inputUsdPerMillion": 0.55,
      "outputUsdPerMillion": 2.1900000000000004,
      "cacheReadUsdPerMillion": 0.14,
      "provider": "deepseek"
    },
    "deepseek/deepseek-reasoner": {
      "inputUsdPerMillion": 0.28,
      "outputUsdPerMillion": 0.42,
      "cacheReadUsdPerMillion": 0.028,
      "provider": "deepseek",
      "sourceUrl": "https://api-docs.deepseek.com/quick_start/pricing"
    },
    "deepseek/deepseek-v3": {
      "inputUsdPerMillion": 0.27,
      "outputUsdPerMillion": 1.1,
      "cacheReadUsdPerMillion": 0.07,
      "cacheWriteUsdPerMillion": 0,
      "provider": "deepseek"
    },
    "deepseek/deepseek-v3.2": {
      "inputUsdPerMillion": 0.28,
      "outputUsdPerMillion": 0.39999999999999997,
      "cacheReadUsdPerMillion": 0.028,
      "provider": "deepseek"
    },
    "deepseek.v3-v1:0": {
      "inputUsdPerMillion": 0.58,
      "outputUsdPerMillion": 1.68,
      "provider": "bedrock_converse",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-deepseek-deepseek-v3-1.html"
    },
    "deepseek.v3.2": {
      "inputUsdPerMillion": 0.62,
      "outputUsdPerMillion": 1.85,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "dolphin": {
      "inputUsdPerMillion": 0.5,
      "outputUsdPerMillion": 0.5,
      "provider": "nlp_cloud"
    },
    "deepseek-v3-2-251201": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "volcengine"
    },
    "glm-4-7-251222": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "volcengine"
    },
    "kimi-k2-thinking-251104": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "volcengine"
    },
    "sail/moonshotai/Kimi-K3": {
      "inputUsdPerMillion": 2.5,
      "outputUsdPerMillion": 12.5,
      "cacheReadUsdPerMillion": 0.25,
      "provider": "sail",
      "sourceUrl": "https://docs.sailresearch.com/models"
    },
    "sail/zai-org/GLM-5.3": {
      "inputUsdPerMillion": 0.98,
      "outputUsdPerMillion": 3.08,
      "cacheReadUsdPerMillion": 0.18,
      "provider": "sail",
      "sourceUrl": "https://docs.sailresearch.com/models"
    },
    "sail/zai-org/GLM-5.3-Flash": {
      "inputUsdPerMillion": 0.11,
      "outputUsdPerMillion": 0.35,
      "cacheReadUsdPerMillion": 0.02,
      "provider": "sail",
      "sourceUrl": "https://docs.sailresearch.com/models"
    },
    "sail/deepseek-ai/DeepSeek-V4-Pro-0813": {
      "inputUsdPerMillion": 0.9199999999999999,
      "outputUsdPerMillion": 2.77,
      "cacheReadUsdPerMillion": 0.04,
      "provider": "sail",
      "sourceUrl": "https://docs.sailresearch.com/models"
    },
    "sail/deepseek-ai/DeepSeek-V4-Flash-0731": {
      "inputUsdPerMillion": 0.09,
      "outputUsdPerMillion": 0.18,
      "cacheReadUsdPerMillion": 0.02,
      "provider": "sail",
      "sourceUrl": "https://docs.sailresearch.com/models"
    },
    "sail/deepseek-ai/DeepSeek-V4.1-Flash": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.6,
      "cacheReadUsdPerMillion": 0.006,
      "provider": "sail",
      "sourceUrl": "https://docs.sailresearch.com/models"
    },
    "sail/moonshotai/Kimi-K2.6": {
      "inputUsdPerMillion": 1,
      "outputUsdPerMillion": 4,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "provider": "sail",
      "sourceUrl": "https://docs.sailresearch.com/models"
    },
    "sail/google/gemma-4-31B-it": {
      "inputUsdPerMillion": 0.39999999999999997,
      "outputUsdPerMillion": 0.6,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "provider": "sail",
      "sourceUrl": "https://docs.sailresearch.com/models"
    },
    "sail/nvidia/Gemma-4-31B-IT-NVFP4": {
      "inputUsdPerMillion": 0.14,
      "outputUsdPerMillion": 0.39999999999999997,
      "cacheReadUsdPerMillion": 0.07,
      "provider": "sail",
      "sourceUrl": "https://docs.sailresearch.com/models"
    },
    "sail/google/gemma-4-12B-it": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 2,
      "cacheReadUsdPerMillion": 0.15,
      "provider": "sail",
      "sourceUrl": "https://docs.sailresearch.com/models"
    },
    "sail/openai/gpt-oss-120b": {
      "inputUsdPerMillion": 0.06,
      "outputUsdPerMillion": 0.39999999999999997,
      "cacheReadUsdPerMillion": 0.03,
      "provider": "sail",
      "sourceUrl": "https://docs.sailresearch.com/models"
    },
    "sail/Qwen/Qwen3.6-35B-A3B": {
      "inputUsdPerMillion": 0.049999999999999996,
      "outputUsdPerMillion": 0.39999999999999997,
      "cacheReadUsdPerMillion": 0.02,
      "provider": "sail",
      "sourceUrl": "https://docs.sailresearch.com/models"
    },
    "eu.amazon.nova-lite-v1:0": {
      "inputUsdPerMillion": 0.078,
      "outputUsdPerMillion": 0.312,
      "cacheReadUsdPerMillion": 0.0195,
      "provider": "bedrock_converse"
    },
    "eu.amazon.nova-micro-v1:0": {
      "inputUsdPerMillion": 0.046,
      "outputUsdPerMillion": 0.184,
      "cacheReadUsdPerMillion": 0.0115,
      "provider": "bedrock_converse"
    },
    "eu.amazon.nova-pro-v1:0": {
      "inputUsdPerMillion": 1.0499999999999998,
      "outputUsdPerMillion": 4.199999999999999,
      "cacheReadUsdPerMillion": 0.26249999999999996,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "eu.anthropic.claude-3-5-haiku-20241022-v1:0": {
      "inputUsdPerMillion": 0.7999999999999999,
      "outputUsdPerMillion": 4,
      "cacheReadUsdPerMillion": 0.08,
      "cacheWriteUsdPerMillion": 1,
      "provider": "bedrock"
    },
    "eu.anthropic.claude-haiku-4-5-20251001-v1:0": {
      "inputUsdPerMillion": 1.1,
      "outputUsdPerMillion": 5.5,
      "cacheReadUsdPerMillion": 0.11,
      "cacheWriteUsdPerMillion": 1.375,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "eu.anthropic.claude-3-5-sonnet-20240620-v1:0": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 15,
      "cacheReadUsdPerMillion": 0.3,
      "cacheWriteUsdPerMillion": 3.75,
      "provider": "bedrock"
    },
    "eu.anthropic.claude-3-5-sonnet-20241022-v2:0": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 15,
      "cacheReadUsdPerMillion": 0.3,
      "cacheWriteUsdPerMillion": 3.75,
      "provider": "bedrock"
    },
    "eu.anthropic.claude-3-7-sonnet-20250219-v1:0": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 15,
      "cacheReadUsdPerMillion": 0.3,
      "cacheWriteUsdPerMillion": 3.75,
      "provider": "bedrock"
    },
    "eu.anthropic.claude-3-opus-20240229-v1:0": {
      "inputUsdPerMillion": 15,
      "outputUsdPerMillion": 75,
      "cacheReadUsdPerMillion": 1.5,
      "cacheWriteUsdPerMillion": 18.75,
      "provider": "bedrock"
    },
    "eu.anthropic.claude-opus-4-1-20250805-v1:0": {
      "inputUsdPerMillion": 15,
      "outputUsdPerMillion": 75,
      "cacheReadUsdPerMillion": 1.5,
      "cacheWriteUsdPerMillion": 18.75,
      "provider": "bedrock_converse"
    },
    "eu.anthropic.claude-opus-4-20250514-v1:0": {
      "inputUsdPerMillion": 15,
      "outputUsdPerMillion": 75,
      "cacheReadUsdPerMillion": 1.5,
      "cacheWriteUsdPerMillion": 18.75,
      "provider": "bedrock_converse"
    },
    "eu.anthropic.claude-sonnet-4-20250514-v1:0": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 15,
      "cacheReadUsdPerMillion": 0.3,
      "cacheWriteUsdPerMillion": 3.75,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "eu.anthropic.claude-sonnet-4-5-20250929-v1:0": {
      "inputUsdPerMillion": 3.3000000000000003,
      "outputUsdPerMillion": 16.5,
      "cacheReadUsdPerMillion": 0.33,
      "cacheWriteUsdPerMillion": 4.125,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "eu.meta.llama3-2-1b-instruct-v1:0": {
      "inputUsdPerMillion": 0.13,
      "outputUsdPerMillion": 0.13,
      "provider": "bedrock"
    },
    "eu.meta.llama3-2-3b-instruct-v1:0": {
      "inputUsdPerMillion": 0.19,
      "outputUsdPerMillion": 0.19,
      "provider": "bedrock"
    },
    "eu.mistral.pixtral-large-2502-v1:0": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 6,
      "provider": "bedrock_converse"
    },
    "fal_ai/fal-ai/moondream3-preview/query": {
      "inputUsdPerMillion": 0.39999999999999997,
      "outputUsdPerMillion": 3.5,
      "provider": "fal_ai",
      "sourceUrl": "https://fal.ai/models/fal-ai/moondream3-preview/query"
    },
    "fireworks_ai/accounts/fireworks/models/deepseek-coder-v2-instruct": {
      "inputUsdPerMillion": 1.2,
      "outputUsdPerMillion": 1.2,
      "provider": "fireworks_ai",
      "sourceUrl": "https://fireworks.ai/pricing"
    },
    "fireworks_ai/accounts/fireworks/models/deepseek-r1": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 8,
      "provider": "fireworks_ai",
      "sourceUrl": "https://fireworks.ai/pricing"
    },
    "fireworks_ai/accounts/fireworks/models/deepseek-r1-0528": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 8,
      "provider": "fireworks_ai",
      "sourceUrl": "https://fireworks.ai/pricing"
    },
    "fireworks_ai/accounts/fireworks/models/deepseek-r1-basic": {
      "inputUsdPerMillion": 0.55,
      "outputUsdPerMillion": 2.1900000000000004,
      "provider": "fireworks_ai",
      "sourceUrl": "https://fireworks.ai/pricing"
    },
    "fireworks_ai/accounts/fireworks/models/deepseek-v3": {
      "inputUsdPerMillion": 0.8999999999999999,
      "outputUsdPerMillion": 0.8999999999999999,
      "provider": "fireworks_ai",
      "sourceUrl": "https://fireworks.ai/pricing"
    },
    "fireworks_ai/accounts/fireworks/models/deepseek-v3-0324": {
      "inputUsdPerMillion": 0.8999999999999999,
      "outputUsdPerMillion": 0.8999999999999999,
      "provider": "fireworks_ai",
      "sourceUrl": "https://fireworks.ai/models/fireworks/deepseek-v3-0324"
    },
    "fireworks_ai/accounts/fireworks/models/deepseek-v3p1": {
      "inputUsdPerMillion": 0.56,
      "outputUsdPerMillion": 1.68,
      "provider": "fireworks_ai",
      "sourceUrl": "https://fireworks.ai/pricing"
    },
    "fireworks_ai/accounts/fireworks/models/deepseek-v3p1-terminus": {
      "inputUsdPerMillion": 0.56,
      "outputUsdPerMillion": 1.68,
      "provider": "fireworks_ai",
      "sourceUrl": "https://fireworks.ai/pricing"
    },
    "fireworks_ai/accounts/fireworks/models/deepseek-v3p2": {
      "inputUsdPerMillion": 0.56,
      "outputUsdPerMillion": 1.68,
      "provider": "fireworks_ai",
      "sourceUrl": "https://fireworks.ai/models/fireworks/deepseek-v3p2"
    },
    "fireworks_ai/accounts/fireworks/models/deepseek-v4-flash": {
      "inputUsdPerMillion": 0.14,
      "outputUsdPerMillion": 0.28,
      "cacheReadUsdPerMillion": 0.028,
      "provider": "fireworks_ai",
      "sourceUrl": "https://docs.fireworks.ai/serverless/pricing"
    },
    "fireworks_ai/accounts/fireworks/models/deepseek-v4-pro-0813": {
      "inputUsdPerMillion": 1.32,
      "outputUsdPerMillion": 3.9600000000000004,
      "cacheReadUsdPerMillion": 0.044,
      "provider": "fireworks_ai",
      "sourceUrl": "https://api.fireworks.ai/v1/serverless/models"
    },
    "fireworks_ai/deepseek-v4-pro-0813": {
      "inputUsdPerMillion": 1.32,
      "outputUsdPerMillion": 3.9600000000000004,
      "cacheReadUsdPerMillion": 0.044,
      "provider": "fireworks_ai",
      "sourceUrl": "https://api.fireworks.ai/v1/serverless/models"
    },
    "fireworks_ai/accounts/fireworks/models/firefunction-v2": {
      "inputUsdPerMillion": 0.8999999999999999,
      "outputUsdPerMillion": 0.8999999999999999,
      "provider": "fireworks_ai",
      "sourceUrl": "https://fireworks.ai/pricing"
    },
    "fireworks_ai/accounts/fireworks/models/glm-4p5": {
      "inputUsdPerMillion": 0.55,
      "outputUsdPerMillion": 2.1900000000000004,
      "provider": "fireworks_ai",
      "sourceUrl": "https://fireworks.ai/models/fireworks/glm-4p5"
    },
    "fireworks_ai/accounts/fireworks/models/glm-4p5-air": {
      "inputUsdPerMillion": 0.22,
      "outputUsdPerMillion": 0.88,
      "provider": "fireworks_ai",
      "sourceUrl": "https://artificialanalysis.ai/models/glm-4-5-air"
    },
    "fireworks_ai/accounts/fireworks/models/glm-4p6": {
      "inputUsdPerMillion": 0.55,
      "outputUsdPerMillion": 2.1900000000000004,
      "provider": "fireworks_ai",
      "sourceUrl": "https://fireworks.ai/pricing"
    },
    "fireworks_ai/accounts/fireworks/models/glm-4p7": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 2.2,
      "cacheReadUsdPerMillion": 0.3,
      "provider": "fireworks_ai",
      "sourceUrl": "https://fireworks.ai/models/fireworks/glm-4p7"
    },
    "fireworks_ai/accounts/fireworks/models/glm-5p1": {
      "inputUsdPerMillion": 1.4,
      "outputUsdPerMillion": 4.4,
      "cacheReadUsdPerMillion": 0.26,
      "provider": "fireworks_ai",
      "sourceUrl": "https://docs.fireworks.ai/serverless/pricing"
    },
    "fireworks_ai/accounts/fireworks/models/glm-5p2": {
      "inputUsdPerMillion": 1.4,
      "outputUsdPerMillion": 4.4,
      "cacheReadUsdPerMillion": 0.14,
      "provider": "fireworks_ai",
      "sourceUrl": "https://api.fireworks.ai/v1/serverless/models"
    },
    "fireworks_ai/accounts/fireworks/models/gpt-oss-120b": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.6,
      "cacheReadUsdPerMillion": 0.015,
      "provider": "fireworks_ai",
      "sourceUrl": "https://api.fireworks.ai/v1/serverless/models"
    },
    "fireworks_ai/accounts/fireworks/models/gpt-oss-20b": {
      "inputUsdPerMillion": 0.07,
      "outputUsdPerMillion": 0.3,
      "cacheReadUsdPerMillion": 0.035,
      "provider": "fireworks_ai",
      "sourceUrl": "https://docs.fireworks.ai/serverless/pricing"
    },
    "fireworks_ai/accounts/fireworks/models/kimi-k2-instruct": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 2.5,
      "provider": "fireworks_ai",
      "sourceUrl": "https://fireworks.ai/models/fireworks/kimi-k2-instruct"
    },
    "fireworks_ai/accounts/fireworks/models/kimi-k2-instruct-0905": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 2.5,
      "provider": "fireworks_ai",
      "sourceUrl": "https://app.fireworks.ai/models/fireworks/kimi-k2-instruct-0905"
    },
    "fireworks_ai/accounts/fireworks/models/kimi-k2-thinking": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 2.5,
      "provider": "fireworks_ai",
      "sourceUrl": "https://fireworks.ai/pricing"
    },
    "fireworks_ai/accounts/fireworks/models/kimi-k2p5": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 3,
      "cacheReadUsdPerMillion": 0.09999999999999999,
      "provider": "fireworks_ai",
      "sourceUrl": "https://fireworks.ai/pricing"
    },
    "fireworks_ai/accounts/fireworks/models/kimi-k2p6": {
      "inputUsdPerMillion": 0.95,
      "outputUsdPerMillion": 4,
      "cacheReadUsdPerMillion": 0.16,
      "provider": "fireworks_ai",
      "sourceUrl": "https://api.fireworks.ai/v1/serverless/models"
    },
    "fireworks_ai/accounts/fireworks/models/kimi-k2p7-code": {
      "inputUsdPerMillion": 0.95,
      "outputUsdPerMillion": 4,
      "cacheReadUsdPerMillion": 0.19,
      "provider": "fireworks_ai",
      "sourceUrl": "https://api.fireworks.ai/v1/serverless/models"
    },
    "fireworks_ai/accounts/fireworks/models/llama-v3p1-405b-instruct": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 3,
      "provider": "fireworks_ai",
      "sourceUrl": "https://fireworks.ai/pricing"
    },
    "fireworks_ai/accounts/fireworks/models/llama-v3p1-8b-instruct": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.09999999999999999,
      "provider": "fireworks_ai",
      "sourceUrl": "https://fireworks.ai/pricing"
    },
    "fireworks_ai/accounts/fireworks/models/llama-v3p2-11b-vision-instruct": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "fireworks_ai",
      "sourceUrl": "https://fireworks.ai/pricing"
    },
    "fireworks_ai/accounts/fireworks/models/llama-v3p2-1b-instruct": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.09999999999999999,
      "provider": "fireworks_ai",
      "sourceUrl": "https://fireworks.ai/pricing"
    },
    "fireworks_ai/accounts/fireworks/models/llama-v3p2-3b-instruct": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.09999999999999999,
      "provider": "fireworks_ai",
      "sourceUrl": "https://fireworks.ai/pricing"
    },
    "fireworks_ai/accounts/fireworks/models/llama-v3p2-90b-vision-instruct": {
      "inputUsdPerMillion": 0.8999999999999999,
      "outputUsdPerMillion": 0.8999999999999999,
      "provider": "fireworks_ai",
      "sourceUrl": "https://fireworks.ai/pricing"
    },
    "fireworks_ai/accounts/fireworks/models/llama4-maverick-instruct-basic": {
      "inputUsdPerMillion": 0.22,
      "outputUsdPerMillion": 0.88,
      "provider": "fireworks_ai",
      "sourceUrl": "https://fireworks.ai/pricing"
    },
    "fireworks_ai/accounts/fireworks/models/llama4-scout-instruct-basic": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.6,
      "provider": "fireworks_ai",
      "sourceUrl": "https://fireworks.ai/pricing"
    },
    "fireworks_ai/accounts/fireworks/models/minimax-m2p1": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 1.2,
      "cacheReadUsdPerMillion": 0.03,
      "provider": "fireworks_ai",
      "sourceUrl": "https://fireworks.ai/models/fireworks/minimax-m2p1"
    },
    "fireworks_ai/accounts/fireworks/models/minimax-m3": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 1.2,
      "cacheReadUsdPerMillion": 0.06,
      "provider": "fireworks_ai",
      "sourceUrl": "https://api.fireworks.ai/v1/serverless/models"
    },
    "fireworks_ai/accounts/fireworks/models/mixtral-8x22b-instruct-hf": {
      "inputUsdPerMillion": 1.2,
      "outputUsdPerMillion": 1.2,
      "provider": "fireworks_ai",
      "sourceUrl": "https://fireworks.ai/pricing"
    },
    "fireworks_ai/accounts/fireworks/models/qwen2-72b-instruct": {
      "inputUsdPerMillion": 0.8999999999999999,
      "outputUsdPerMillion": 0.8999999999999999,
      "provider": "fireworks_ai",
      "sourceUrl": "https://fireworks.ai/pricing"
    },
    "fireworks_ai/accounts/fireworks/models/qwen2p5-coder-32b-instruct": {
      "inputUsdPerMillion": 0.8999999999999999,
      "outputUsdPerMillion": 0.8999999999999999,
      "provider": "fireworks_ai",
      "sourceUrl": "https://fireworks.ai/pricing"
    },
    "fireworks_ai/accounts/fireworks/models/yi-large": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 3,
      "provider": "fireworks_ai",
      "sourceUrl": "https://fireworks.ai/pricing"
    },
    "fireworks_ai/deepseek-v4-flash": {
      "inputUsdPerMillion": 0.14,
      "outputUsdPerMillion": 0.28,
      "cacheReadUsdPerMillion": 0.028,
      "provider": "fireworks_ai",
      "sourceUrl": "https://docs.fireworks.ai/serverless/pricing"
    },
    "fireworks_ai/glm-4p7": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 2.2,
      "cacheReadUsdPerMillion": 0.3,
      "provider": "fireworks_ai",
      "sourceUrl": "https://fireworks.ai/models/fireworks/glm-4p7"
    },
    "fireworks_ai/glm-5p1": {
      "inputUsdPerMillion": 1.4,
      "outputUsdPerMillion": 4.4,
      "cacheReadUsdPerMillion": 0.26,
      "provider": "fireworks_ai",
      "sourceUrl": "https://docs.fireworks.ai/serverless/pricing"
    },
    "fireworks_ai/glm-5p1-fast": {
      "inputUsdPerMillion": 2.8,
      "outputUsdPerMillion": 8.8,
      "cacheReadUsdPerMillion": 0.52,
      "provider": "fireworks_ai",
      "sourceUrl": "https://docs.fireworks.ai/serverless/pricing"
    },
    "fireworks_ai/glm-5p2": {
      "inputUsdPerMillion": 1.4,
      "outputUsdPerMillion": 4.4,
      "cacheReadUsdPerMillion": 0.14,
      "provider": "fireworks_ai",
      "sourceUrl": "https://api.fireworks.ai/v1/serverless/models"
    },
    "fireworks_ai/gpt-oss-120b": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.6,
      "cacheReadUsdPerMillion": 0.015,
      "provider": "fireworks_ai",
      "sourceUrl": "https://api.fireworks.ai/v1/serverless/models"
    },
    "fireworks_ai/gpt-oss-20b": {
      "inputUsdPerMillion": 0.07,
      "outputUsdPerMillion": 0.3,
      "cacheReadUsdPerMillion": 0.035,
      "provider": "fireworks_ai",
      "sourceUrl": "https://docs.fireworks.ai/serverless/pricing"
    },
    "fireworks_ai/kimi-k2p5": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 3,
      "cacheReadUsdPerMillion": 0.09999999999999999,
      "provider": "fireworks_ai",
      "sourceUrl": "https://fireworks.ai/pricing"
    },
    "fireworks_ai/kimi-k2p6": {
      "inputUsdPerMillion": 0.95,
      "outputUsdPerMillion": 4,
      "cacheReadUsdPerMillion": 0.16,
      "provider": "fireworks_ai",
      "sourceUrl": "https://api.fireworks.ai/v1/serverless/models"
    },
    "fireworks_ai/kimi-k2p6-fast": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 8,
      "cacheReadUsdPerMillion": 0.3,
      "provider": "fireworks_ai",
      "sourceUrl": "https://docs.fireworks.ai/serverless/pricing"
    },
    "fireworks_ai/kimi-k2p7-code": {
      "inputUsdPerMillion": 0.95,
      "outputUsdPerMillion": 4,
      "cacheReadUsdPerMillion": 0.19,
      "provider": "fireworks_ai",
      "sourceUrl": "https://api.fireworks.ai/v1/serverless/models"
    },
    "fireworks_ai/kimi-k2p7-code-fast": {
      "inputUsdPerMillion": 1.9,
      "outputUsdPerMillion": 8,
      "cacheReadUsdPerMillion": 0.38,
      "provider": "fireworks_ai",
      "sourceUrl": "https://docs.fireworks.ai/serverless/pricing"
    },
    "fireworks_ai/minimax-m2p1": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 1.2,
      "cacheReadUsdPerMillion": 0.03,
      "provider": "fireworks_ai",
      "sourceUrl": "https://fireworks.ai/models/fireworks/minimax-m2p1"
    },
    "fireworks_ai/minimax-m3": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 1.2,
      "cacheReadUsdPerMillion": 0.06,
      "provider": "fireworks_ai",
      "sourceUrl": "https://api.fireworks.ai/v1/serverless/models"
    },
    "fireworks_ai/qwen3p7-plus": {
      "inputUsdPerMillion": 0.39999999999999997,
      "outputUsdPerMillion": 1.5999999999999999,
      "cacheReadUsdPerMillion": 0.08,
      "provider": "fireworks_ai",
      "sourceUrl": "https://api.fireworks.ai/v1/serverless/models"
    },
    "friendliai/zai-org/GLM-5.3-Flash": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.5,
      "cacheReadUsdPerMillion": 0.03,
      "provider": "friendliai",
      "sourceUrl": "https://api.friendli.ai/serverless/v1/models"
    },
    "friendliai/zai-org/GLM-5.3": {
      "inputUsdPerMillion": 1.26,
      "outputUsdPerMillion": 3.9600000000000004,
      "cacheReadUsdPerMillion": 0.234,
      "provider": "friendliai",
      "sourceUrl": "https://api.friendli.ai/serverless/v1/models"
    },
    "friendliai/google/gemma-4-31B-it": {
      "inputUsdPerMillion": 0.14,
      "outputUsdPerMillion": 0.39999999999999997,
      "provider": "friendliai",
      "sourceUrl": "https://api.friendli.ai/serverless/v1/models"
    },
    "friendliai/zai-org/GLM-5.2": {
      "inputUsdPerMillion": 1.4,
      "outputUsdPerMillion": 4.4,
      "cacheReadUsdPerMillion": 0.26,
      "provider": "friendliai",
      "sourceUrl": "https://api.friendli.ai/serverless/v1/models"
    },
    "friendliai/deepseek-ai/DeepSeek-V3.2": {
      "inputUsdPerMillion": 0.5,
      "outputUsdPerMillion": 1.5,
      "cacheReadUsdPerMillion": 0.25,
      "provider": "friendliai",
      "sourceUrl": "https://api.friendli.ai/serverless/v1/models"
    },
    "friendliai/MiniMaxAI/MiniMax-M2.5": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 1.2,
      "cacheReadUsdPerMillion": 0.06,
      "provider": "friendliai",
      "sourceUrl": "https://api.friendli.ai/serverless/v1/models"
    },
    "friendliai/zai-org/GLM-5.1": {
      "inputUsdPerMillion": 1.4,
      "outputUsdPerMillion": 4.4,
      "cacheReadUsdPerMillion": 0.26,
      "provider": "friendliai",
      "sourceUrl": "https://api.friendli.ai/serverless/v1/models"
    },
    "ft:babbage-002": {
      "inputUsdPerMillion": 1.5999999999999999,
      "outputUsdPerMillion": 1.5999999999999999,
      "provider": "text-completion-openai",
      "sourceUrl": "https://developers.openai.com/api/docs/pricing"
    },
    "ft:davinci-002": {
      "inputUsdPerMillion": 12,
      "outputUsdPerMillion": 12,
      "provider": "text-completion-openai",
      "sourceUrl": "https://developers.openai.com/api/docs/pricing"
    },
    "ft:gpt-3.5-turbo": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 6,
      "provider": "openai",
      "sourceUrl": "https://developers.openai.com/api/docs/pricing"
    },
    "ft:gpt-3.5-turbo-0125": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 6,
      "provider": "openai"
    },
    "ft:gpt-3.5-turbo-0613": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 6,
      "provider": "openai"
    },
    "ft:gpt-3.5-turbo-1106": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 6,
      "provider": "openai"
    },
    "ft:gpt-4-0613": {
      "inputUsdPerMillion": 30,
      "outputUsdPerMillion": 60,
      "provider": "openai"
    },
    "ft:gpt-4o-2024-08-06": {
      "inputUsdPerMillion": 3.75,
      "outputUsdPerMillion": 15,
      "cacheReadUsdPerMillion": 1.875,
      "provider": "openai",
      "sourceUrl": "https://developers.openai.com/api/docs/pricing"
    },
    "ft:gpt-4o-2024-11-20": {
      "inputUsdPerMillion": 3.75,
      "outputUsdPerMillion": 15,
      "cacheWriteUsdPerMillion": 1.875,
      "provider": "openai"
    },
    "ft:gpt-4o-mini-2024-07-18": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 1.2,
      "cacheReadUsdPerMillion": 0.15,
      "provider": "openai",
      "sourceUrl": "https://developers.openai.com/api/docs/pricing"
    },
    "ft:gpt-4.1-2025-04-14": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 12,
      "cacheReadUsdPerMillion": 0.75,
      "provider": "openai",
      "sourceUrl": "https://developers.openai.com/api/docs/pricing"
    },
    "ft:gpt-4.1-mini-2025-04-14": {
      "inputUsdPerMillion": 0.7999999999999999,
      "outputUsdPerMillion": 3.1999999999999997,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "provider": "openai",
      "sourceUrl": "https://developers.openai.com/api/docs/pricing"
    },
    "ft:gpt-4.1-nano-2025-04-14": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.7999999999999999,
      "cacheReadUsdPerMillion": 0.049999999999999996,
      "provider": "openai",
      "sourceUrl": "https://developers.openai.com/api/docs/pricing"
    },
    "ft:o4-mini-2025-04-16": {
      "inputUsdPerMillion": 4,
      "outputUsdPerMillion": 16,
      "cacheReadUsdPerMillion": 1,
      "provider": "openai",
      "sourceUrl": "https://developers.openai.com/api/docs/pricing"
    },
    "gemini-2.5-flash": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 2.5,
      "cacheReadUsdPerMillion": 0.03,
      "reasoningUsdPerMillion": 2.5,
      "provider": "vertex_ai-language-models",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "gemini-3.1-flash-lite-preview": {
      "inputUsdPerMillion": 0.25,
      "outputUsdPerMillion": 1.5,
      "cacheReadUsdPerMillion": 0.024999999999999998,
      "reasoningUsdPerMillion": 1.5,
      "provider": "vertex_ai-language-models",
      "sourceUrl": "https://ai.google.dev/gemini-api/docs/models"
    },
    "gemini-3.1-flash-lite": {
      "inputUsdPerMillion": 0.25,
      "outputUsdPerMillion": 1.5,
      "cacheReadUsdPerMillion": 0.024999999999999998,
      "reasoningUsdPerMillion": 1.5,
      "provider": "vertex_ai-language-models",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "gemini-3.5-flash-lite": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 2.5,
      "cacheReadUsdPerMillion": 0.03,
      "reasoningUsdPerMillion": 2.5,
      "provider": "vertex_ai-language-models",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "deep-research-pro-preview-12-2025": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 12,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "provider": "vertex_ai-language-models",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "gemini-2.5-flash-lite": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.39999999999999997,
      "cacheReadUsdPerMillion": 0.01,
      "reasoningUsdPerMillion": 0.39999999999999997,
      "provider": "vertex_ai-language-models",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "gemini-2.5-flash-lite-preview-09-2025": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.39999999999999997,
      "cacheReadUsdPerMillion": 0.01,
      "reasoningUsdPerMillion": 0.39999999999999997,
      "provider": "vertex_ai-language-models",
      "sourceUrl": "https://developers.googleblog.com/en/continuing-to-bring-you-our-latest-models-with-an-improved-gemini-2-5-flash-and-flash-lite-release/"
    },
    "gemini-2.5-flash-preview-09-2025": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 2.5,
      "cacheReadUsdPerMillion": 0.03,
      "reasoningUsdPerMillion": 2.5,
      "provider": "vertex_ai-language-models",
      "sourceUrl": "https://cloud.google.com/vertex-ai/generative-ai/pricing"
    },
    "gemini-2.5-pro": {
      "inputUsdPerMillion": 1.25,
      "outputUsdPerMillion": 10,
      "cacheReadUsdPerMillion": 0.125,
      "provider": "vertex_ai-language-models",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "gemini-3.1-pro-preview": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 12,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "provider": "vertex_ai-language-models",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "gemini-3.1-pro-preview-customtools": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 12,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "provider": "vertex_ai-language-models",
      "sourceUrl": "https://cloud.google.com/vertex-ai/generative-ai/pricing#gemini-models"
    },
    "vertex_ai/gemini-3-pro-preview": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 12,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "provider": "vertex_ai",
      "sourceUrl": "https://cloud.google.com/vertex-ai/generative-ai/pricing"
    },
    "vertex_ai/gemini-3-flash-preview": {
      "inputUsdPerMillion": 0.5,
      "outputUsdPerMillion": 3,
      "cacheReadUsdPerMillion": 0.049999999999999996,
      "provider": "vertex_ai",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "vertex_ai/gemini-3.5-flash": {
      "inputUsdPerMillion": 1.5,
      "outputUsdPerMillion": 9,
      "cacheReadUsdPerMillion": 0.15,
      "reasoningUsdPerMillion": 9,
      "provider": "vertex_ai",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "vertex_ai/gemini-3.6-flash": {
      "inputUsdPerMillion": 0.75,
      "outputUsdPerMillion": 3.75,
      "cacheReadUsdPerMillion": 0.075,
      "reasoningUsdPerMillion": 3.75,
      "provider": "vertex_ai",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "vertex_ai/gemini-3.7-flash": {
      "inputUsdPerMillion": 0.75,
      "outputUsdPerMillion": 3.75,
      "cacheReadUsdPerMillion": 0.075,
      "reasoningUsdPerMillion": 3.75,
      "provider": "vertex_ai",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "vertex_ai/gemini-3.8-flash": {
      "inputUsdPerMillion": 0.75,
      "outputUsdPerMillion": 3.75,
      "cacheReadUsdPerMillion": 0.075,
      "reasoningUsdPerMillion": 3.75,
      "provider": "vertex_ai",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "vertex_ai/gemini-3.8-flash-cyber": {
      "inputUsdPerMillion": 1.5,
      "outputUsdPerMillion": 7.5,
      "cacheReadUsdPerMillion": 0.15,
      "reasoningUsdPerMillion": 7.5,
      "provider": "vertex_ai",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "vertex_ai/gemini-3.1-pro-preview": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 12,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "provider": "vertex_ai",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "vertex_ai/gemini-3.1-pro-preview-customtools": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 12,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "provider": "vertex_ai",
      "sourceUrl": "https://cloud.google.com/vertex-ai/generative-ai/pricing#gemini-models"
    },
    "gemini-2.5-pro-preview-tts": {
      "inputUsdPerMillion": 1,
      "outputUsdPerMillion": 20,
      "cacheReadUsdPerMillion": 0.125,
      "provider": "vertex_ai-language-models",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "gemini-robotics-er-1.5-preview": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 2.5,
      "cacheReadUsdPerMillion": 0,
      "reasoningUsdPerMillion": 2.5,
      "provider": "vertex_ai-language-models",
      "sourceUrl": "https://ai.google.dev/gemini-api/docs/models#gemini-robotics-er-1-5-preview"
    },
    "gemini/gemini-robotics-er-2-preview": {
      "inputUsdPerMillion": 1,
      "outputUsdPerMillion": 5,
      "cacheReadUsdPerMillion": 0.09999999999999999,
      "reasoningUsdPerMillion": 5,
      "provider": "gemini",
      "sourceUrl": "https://ai.google.dev/gemini-api/docs/pricing"
    },
    "gemini-2.5-computer-use-preview-10-2025": {
      "inputUsdPerMillion": 1.25,
      "outputUsdPerMillion": 10,
      "provider": "vertex_ai-language-models",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "gemini/gemini-3.1-flash-lite-preview": {
      "inputUsdPerMillion": 0.25,
      "outputUsdPerMillion": 1.5,
      "cacheReadUsdPerMillion": 0.024999999999999998,
      "reasoningUsdPerMillion": 1.5,
      "provider": "gemini",
      "sourceUrl": "https://ai.google.dev/gemini-api/docs/pricing"
    },
    "gemini/deep-research-preview-04-2026": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 12,
      "provider": "gemini",
      "sourceUrl": "https://ai.google.dev/gemini-api/docs/pricing"
    },
    "gemini/deep-research-max-preview-04-2026": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 12,
      "provider": "gemini",
      "sourceUrl": "https://ai.google.dev/gemini-api/docs/pricing"
    },
    "gemini/gemini-2.5-flash": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 2.5,
      "cacheReadUsdPerMillion": 0.03,
      "reasoningUsdPerMillion": 2.5,
      "provider": "gemini",
      "sourceUrl": "https://ai.google.dev/gemini-api/docs/pricing"
    },
    "gemini/deep-research-pro-preview-12-2025": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 12,
      "provider": "gemini",
      "sourceUrl": "https://ai.google.dev/gemini-api/docs/models/deep-research-pro-preview-12-2025"
    },
    "gemini/gemini-2.5-flash-lite": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.39999999999999997,
      "cacheReadUsdPerMillion": 0.01,
      "reasoningUsdPerMillion": 0.39999999999999997,
      "provider": "gemini",
      "sourceUrl": "https://ai.google.dev/gemini-api/docs/pricing"
    },
    "gemini/gemini-flash-latest": {
      "inputUsdPerMillion": 0.75,
      "outputUsdPerMillion": 3.75,
      "cacheReadUsdPerMillion": 0.075,
      "reasoningUsdPerMillion": 3.75,
      "provider": "gemini",
      "sourceUrl": "https://ai.google.dev/gemini-api/docs/pricing"
    },
    "gemini/gemini-flash-lite-latest": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 2.5,
      "cacheReadUsdPerMillion": 0.03,
      "reasoningUsdPerMillion": 2.5,
      "provider": "gemini",
      "sourceUrl": "https://ai.google.dev/gemini-api/docs/pricing"
    },
    "gemini/gemini-2.5-pro": {
      "inputUsdPerMillion": 1.25,
      "outputUsdPerMillion": 10,
      "cacheReadUsdPerMillion": 0.125,
      "provider": "gemini",
      "sourceUrl": "https://ai.google.dev/gemini-api/docs/pricing"
    },
    "gemini/gemini-2.5-computer-use-preview-10-2025": {
      "inputUsdPerMillion": 1.25,
      "outputUsdPerMillion": 10,
      "provider": "gemini",
      "sourceUrl": "https://ai.google.dev/gemini-api/docs/pricing"
    },
    "gemini/gemini-3.1-flash-lite": {
      "inputUsdPerMillion": 0.25,
      "outputUsdPerMillion": 1.5,
      "cacheReadUsdPerMillion": 0.024999999999999998,
      "reasoningUsdPerMillion": 1.5,
      "provider": "gemini",
      "sourceUrl": "https://ai.google.dev/gemini-api/docs/pricing"
    },
    "gemini/gemini-3.5-flash-lite": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 2.5,
      "cacheReadUsdPerMillion": 0.03,
      "reasoningUsdPerMillion": 2.5,
      "provider": "gemini",
      "sourceUrl": "https://ai.google.dev/gemini-api/docs/pricing"
    },
    "gemini/gemini-3-flash-preview": {
      "inputUsdPerMillion": 0.5,
      "outputUsdPerMillion": 3,
      "cacheReadUsdPerMillion": 0.049999999999999996,
      "reasoningUsdPerMillion": 3,
      "provider": "gemini",
      "sourceUrl": "https://ai.google.dev/gemini-api/docs/pricing"
    },
    "gemini/gemini-3.5-flash": {
      "inputUsdPerMillion": 1.5,
      "outputUsdPerMillion": 9,
      "cacheReadUsdPerMillion": 0.15,
      "reasoningUsdPerMillion": 9,
      "provider": "gemini",
      "sourceUrl": "https://ai.google.dev/gemini-api/docs/pricing"
    },
    "gemini/gemini-3.6-flash": {
      "inputUsdPerMillion": 0.75,
      "outputUsdPerMillion": 3.75,
      "cacheReadUsdPerMillion": 0.075,
      "reasoningUsdPerMillion": 3.75,
      "provider": "gemini",
      "sourceUrl": "https://ai.google.dev/gemini-api/docs/pricing"
    },
    "gemini/gemini-3.7-flash": {
      "inputUsdPerMillion": 0.75,
      "outputUsdPerMillion": 3.75,
      "cacheReadUsdPerMillion": 0.075,
      "reasoningUsdPerMillion": 3.75,
      "provider": "gemini",
      "sourceUrl": "https://ai.google.dev/gemini-api/docs/pricing"
    },
    "gemini/gemini-3.8-flash": {
      "inputUsdPerMillion": 0.75,
      "outputUsdPerMillion": 3.75,
      "cacheReadUsdPerMillion": 0.075,
      "reasoningUsdPerMillion": 3.75,
      "provider": "gemini",
      "sourceUrl": "https://ai.google.dev/gemini-api/docs/pricing"
    },
    "gemini/gemini-omni-flash-preview": {
      "inputUsdPerMillion": 1.5,
      "outputUsdPerMillion": 9,
      "reasoningUsdPerMillion": 9,
      "provider": "gemini",
      "sourceUrl": "https://ai.google.dev/gemini-api/docs/pricing"
    },
    "gemini/gemini-3.1-pro-preview": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 12,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "provider": "gemini",
      "sourceUrl": "https://ai.google.dev/gemini-api/docs/pricing"
    },
    "gemini/gemini-3.1-pro-preview-customtools": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 12,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "provider": "gemini",
      "sourceUrl": "https://ai.google.dev/gemini-api/docs/pricing"
    },
    "gemini-3-flash-preview": {
      "inputUsdPerMillion": 0.5,
      "outputUsdPerMillion": 3,
      "cacheReadUsdPerMillion": 0.049999999999999996,
      "reasoningUsdPerMillion": 3,
      "provider": "vertex_ai-language-models",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "gemini-omni-flash-preview": {
      "inputUsdPerMillion": 1.5,
      "outputUsdPerMillion": 9,
      "reasoningUsdPerMillion": 9,
      "provider": "vertex_ai-language-models",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "gemini-3.5-flash": {
      "inputUsdPerMillion": 1.5,
      "outputUsdPerMillion": 9,
      "cacheReadUsdPerMillion": 0.15,
      "reasoningUsdPerMillion": 9,
      "provider": "vertex_ai-language-models",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "gemini-3.6-flash": {
      "inputUsdPerMillion": 0.75,
      "outputUsdPerMillion": 3.75,
      "cacheReadUsdPerMillion": 0.075,
      "reasoningUsdPerMillion": 3.75,
      "provider": "vertex_ai-language-models",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "gemini-3.7-flash": {
      "inputUsdPerMillion": 0.75,
      "outputUsdPerMillion": 3.75,
      "cacheReadUsdPerMillion": 0.075,
      "reasoningUsdPerMillion": 3.75,
      "provider": "vertex_ai-language-models",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "gemini-3.8-flash": {
      "inputUsdPerMillion": 0.75,
      "outputUsdPerMillion": 3.75,
      "cacheReadUsdPerMillion": 0.075,
      "reasoningUsdPerMillion": 3.75,
      "provider": "vertex_ai-language-models",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "gemini-3.8-flash-cyber": {
      "inputUsdPerMillion": 1.5,
      "outputUsdPerMillion": 7.5,
      "cacheReadUsdPerMillion": 0.15,
      "reasoningUsdPerMillion": 7.5,
      "provider": "vertex_ai-language-models",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "gemini/gemini-2.5-pro-preview-tts": {
      "inputUsdPerMillion": 1,
      "outputUsdPerMillion": 20,
      "cacheReadUsdPerMillion": 0.125,
      "provider": "gemini",
      "sourceUrl": "https://ai.google.dev/gemini-api/docs/pricing"
    },
    "gemini/gemini-exp-1114": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "gemini",
      "sourceUrl": "https://ai.google.dev/pricing"
    },
    "gemini/gemini-exp-1206": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "gemini",
      "sourceUrl": "https://ai.google.dev/pricing"
    },
    "gemini/gemini-gemma-2-27b-it": {
      "inputUsdPerMillion": 0.35,
      "outputUsdPerMillion": 1.0499999999999998,
      "provider": "gemini",
      "sourceUrl": "https://cloud.google.com/vertex-ai/generative-ai/docs/learn/models#foundation_models"
    },
    "gemini/gemini-gemma-2-9b-it": {
      "inputUsdPerMillion": 0.35,
      "outputUsdPerMillion": 1.0499999999999998,
      "provider": "gemini",
      "sourceUrl": "https://cloud.google.com/vertex-ai/generative-ai/docs/learn/models#foundation_models"
    },
    "gemini/gemma-3-27b-it": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "gemini",
      "sourceUrl": "https://aistudio.google.com"
    },
    "gemini/gemma-4-26b-a4b-it": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "gemini",
      "sourceUrl": "https://ai.google.dev/gemini-api/docs/pricing"
    },
    "gemini/gemma-4-31b-it": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "gemini",
      "sourceUrl": "https://ai.google.dev/gemini-api/docs/pricing"
    },
    "gemini/learnlm-1.5-pro-experimental": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "gemini",
      "sourceUrl": "https://aistudio.google.com"
    },
    "gemini/lyria-3-clip-preview": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "gemini",
      "sourceUrl": "https://ai.google.dev/gemini-api/docs/pricing"
    },
    "gemini/lyria-3-pro-preview": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "gemini",
      "sourceUrl": "https://ai.google.dev/gemini-api/docs/pricing"
    },
    "github_copilot/claude-haiku-4.5": {
      "inputUsdPerMillion": 1,
      "outputUsdPerMillion": 5,
      "cacheReadUsdPerMillion": 0.09999999999999999,
      "cacheWriteUsdPerMillion": 1.25,
      "provider": "github_copilot"
    },
    "github_copilot/claude-haiku-5.5": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.5,
      "cacheReadUsdPerMillion": 0.01,
      "cacheWriteUsdPerMillion": 0.125,
      "provider": "github_copilot",
      "sourceUrl": "https://raw.githubusercontent.com/github/docs/main/data/tables/copilot/models-and-pricing.yml"
    },
    "github_copilot/gpt-5-mini": {
      "inputUsdPerMillion": 0.25,
      "outputUsdPerMillion": 2,
      "cacheReadUsdPerMillion": 0.024999999999999998,
      "provider": "github_copilot"
    },
    "gigachat/GigaChat-2": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "gigachat"
    },
    "gigachat/GigaChat-2-Max": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "gigachat"
    },
    "gigachat/GigaChat-2-Pro": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "gigachat"
    },
    "gmi/anthropic/claude-opus-4.5": {
      "inputUsdPerMillion": 5,
      "outputUsdPerMillion": 25,
      "provider": "gmi"
    },
    "gmi/anthropic/claude-sonnet-4.5": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 15,
      "provider": "gmi"
    },
    "gmi/anthropic/claude-sonnet-4": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 15,
      "provider": "gmi"
    },
    "gmi/anthropic/claude-opus-4": {
      "inputUsdPerMillion": 15,
      "outputUsdPerMillion": 75,
      "provider": "gmi"
    },
    "gmi/openai/gpt-5.2": {
      "inputUsdPerMillion": 1.75,
      "outputUsdPerMillion": 14,
      "provider": "gmi"
    },
    "gmi/openai/gpt-5.1": {
      "inputUsdPerMillion": 1.25,
      "outputUsdPerMillion": 10,
      "provider": "gmi"
    },
    "gmi/openai/gpt-5": {
      "inputUsdPerMillion": 1.25,
      "outputUsdPerMillion": 10,
      "provider": "gmi"
    },
    "gmi/openai/gpt-4o": {
      "inputUsdPerMillion": 2.5,
      "outputUsdPerMillion": 10,
      "provider": "gmi"
    },
    "gmi/openai/gpt-4o-mini": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.6,
      "provider": "gmi"
    },
    "gmi/deepseek-ai/DeepSeek-V3.2": {
      "inputUsdPerMillion": 0.28,
      "outputUsdPerMillion": 0.39999999999999997,
      "provider": "gmi"
    },
    "gmi/deepseek-ai/DeepSeek-V3-0324": {
      "inputUsdPerMillion": 0.28,
      "outputUsdPerMillion": 0.88,
      "provider": "gmi"
    },
    "gmi/google/gemini-3-flash-preview": {
      "inputUsdPerMillion": 0.5,
      "outputUsdPerMillion": 3,
      "provider": "gmi"
    },
    "gmi/moonshotai/Kimi-K2-Thinking": {
      "inputUsdPerMillion": 0.7999999999999999,
      "outputUsdPerMillion": 1.2,
      "provider": "gmi"
    },
    "gmi/MiniMaxAI/MiniMax-M2.1": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 1.2,
      "provider": "gmi"
    },
    "baseten/MiniMaxAI/MiniMax-M2.5": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 1.2,
      "provider": "baseten"
    },
    "baseten/nvidia/Nemotron-120B-A12B": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 0.75,
      "provider": "baseten"
    },
    "baseten/zai-org/GLM-5": {
      "inputUsdPerMillion": 0.95,
      "outputUsdPerMillion": 3.15,
      "provider": "baseten"
    },
    "baseten/zai-org/GLM-4.7": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 2.2,
      "cacheReadUsdPerMillion": 0.12,
      "provider": "baseten",
      "sourceUrl": "https://inference.baseten.co/v1/models"
    },
    "baseten/zai-org/GLM-4.6": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 2.2,
      "provider": "baseten"
    },
    "baseten/moonshotai/Kimi-K2.5": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 3,
      "provider": "baseten"
    },
    "baseten/moonshotai/Kimi-K2-Thinking": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 2.5,
      "provider": "baseten"
    },
    "baseten/moonshotai/Kimi-K2-Instruct-0905": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 2.5,
      "provider": "baseten"
    },
    "baseten/openai/gpt-oss-120b": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.5,
      "cacheReadUsdPerMillion": 0.09999999999999999,
      "provider": "baseten",
      "sourceUrl": "https://inference.baseten.co/v1/models"
    },
    "baseten/deepseek-ai/DeepSeek-V3.1": {
      "inputUsdPerMillion": 0.5,
      "outputUsdPerMillion": 1.5,
      "provider": "baseten"
    },
    "baseten/deepseek-ai/DeepSeek-V3-0324": {
      "inputUsdPerMillion": 0.77,
      "outputUsdPerMillion": 0.77,
      "provider": "baseten"
    },
    "gmi/Qwen/Qwen3-VL-235B-A22B-Instruct-FP8": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 1.4,
      "provider": "gmi"
    },
    "gmi/zai-org/GLM-4.7-FP8": {
      "inputUsdPerMillion": 0.39999999999999997,
      "outputUsdPerMillion": 2,
      "provider": "gmi"
    },
    "google.gemma-3-12b-it": {
      "inputUsdPerMillion": 0.09,
      "outputUsdPerMillion": 0.29,
      "provider": "bedrock_converse",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-google-gemma-3-12b-it.html"
    },
    "google.gemma-3-27b-it": {
      "inputUsdPerMillion": 0.22999999999999998,
      "outputUsdPerMillion": 0.38,
      "provider": "bedrock_converse",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-google-gemma-3-27b-pt.html"
    },
    "google.gemma-3-4b-it": {
      "inputUsdPerMillion": 0.04,
      "outputUsdPerMillion": 0.08,
      "provider": "bedrock_converse",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-google-gemma-3-4b-it.html"
    },
    "global.anthropic.claude-sonnet-4-5-20250929-v1:0": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 15,
      "cacheReadUsdPerMillion": 0.3,
      "cacheWriteUsdPerMillion": 3.75,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "global.anthropic.claude-sonnet-4-20250514-v1:0": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 15,
      "cacheReadUsdPerMillion": 0.3,
      "cacheWriteUsdPerMillion": 3.75,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "global.anthropic.claude-haiku-4-5-20251001-v1:0": {
      "inputUsdPerMillion": 1,
      "outputUsdPerMillion": 5,
      "cacheReadUsdPerMillion": 0.09999999999999999,
      "cacheWriteUsdPerMillion": 1.25,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "global.amazon.nova-2-lite-v1:0": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 2.5,
      "cacheReadUsdPerMillion": 0.075,
      "provider": "bedrock_converse"
    },
    "gpt-3.5-turbo": {
      "inputUsdPerMillion": 0.5,
      "outputUsdPerMillion": 1.5,
      "provider": "openai",
      "sourceUrl": "https://developers.openai.com/api/docs/pricing"
    },
    "gpt-3.5-turbo-0125": {
      "inputUsdPerMillion": 0.5,
      "outputUsdPerMillion": 1.5,
      "provider": "openai",
      "sourceUrl": "https://developers.openai.com/api/docs/pricing"
    },
    "gpt-3.5-turbo-1106": {
      "inputUsdPerMillion": 1,
      "outputUsdPerMillion": 2,
      "provider": "openai",
      "sourceUrl": "https://developers.openai.com/api/docs/pricing"
    },
    "gpt-3.5-turbo-16k": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 4,
      "provider": "openai"
    },
    "gpt-3.5-turbo-instruct": {
      "inputUsdPerMillion": 1.5,
      "outputUsdPerMillion": 2,
      "provider": "text-completion-openai",
      "sourceUrl": "https://developers.openai.com/api/docs/pricing"
    },
    "gpt-3.5-turbo-instruct-0914": {
      "inputUsdPerMillion": 1.5,
      "outputUsdPerMillion": 2,
      "provider": "text-completion-openai"
    },
    "gpt-4": {
      "inputUsdPerMillion": 30,
      "outputUsdPerMillion": 60,
      "provider": "openai"
    },
    "gpt-4-0613": {
      "inputUsdPerMillion": 30,
      "outputUsdPerMillion": 60,
      "provider": "openai",
      "sourceUrl": "https://developers.openai.com/api/docs/pricing"
    },
    "gpt-4-1106-preview": {
      "inputUsdPerMillion": 10,
      "outputUsdPerMillion": 30,
      "provider": "openai"
    },
    "gpt-4-turbo": {
      "inputUsdPerMillion": 10,
      "outputUsdPerMillion": 30,
      "provider": "openai"
    },
    "gpt-4-turbo-2024-04-09": {
      "inputUsdPerMillion": 10,
      "outputUsdPerMillion": 30,
      "provider": "openai",
      "sourceUrl": "https://developers.openai.com/api/docs/pricing"
    },
    "gpt-4.1": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 8,
      "cacheReadUsdPerMillion": 0.5,
      "provider": "openai",
      "sourceUrl": "https://developers.openai.com/api/docs/pricing"
    },
    "gpt-4.1-2025-04-14": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 8,
      "cacheReadUsdPerMillion": 0.5,
      "provider": "openai",
      "sourceUrl": "https://developers.openai.com/api/docs/pricing"
    },
    "gpt-4.1-mini": {
      "inputUsdPerMillion": 0.39999999999999997,
      "outputUsdPerMillion": 1.5999999999999999,
      "cacheReadUsdPerMillion": 0.09999999999999999,
      "provider": "openai",
      "sourceUrl": "https://developers.openai.com/api/docs/pricing"
    },
    "gpt-4.1-mini-2025-04-14": {
      "inputUsdPerMillion": 0.39999999999999997,
      "outputUsdPerMillion": 1.5999999999999999,
      "cacheReadUsdPerMillion": 0.09999999999999999,
      "provider": "openai",
      "sourceUrl": "https://developers.openai.com/api/docs/pricing"
    },
    "gpt-4.1-nano": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.39999999999999997,
      "cacheReadUsdPerMillion": 0.024999999999999998,
      "provider": "openai",
      "sourceUrl": "https://developers.openai.com/api/docs/pricing"
    },
    "gpt-4.1-nano-2025-04-14": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.39999999999999997,
      "cacheReadUsdPerMillion": 0.024999999999999998,
      "provider": "openai",
      "sourceUrl": "https://developers.openai.com/api/docs/pricing"
    },
    "gpt-4o": {
      "inputUsdPerMillion": 2.5,
      "outputUsdPerMillion": 10,
      "cacheReadUsdPerMillion": 1.25,
      "provider": "openai",
      "sourceUrl": "https://developers.openai.com/api/docs/pricing"
    },
    "gpt-4o-2024-05-13": {
      "inputUsdPerMillion": 5,
      "outputUsdPerMillion": 15,
      "provider": "openai",
      "sourceUrl": "https://developers.openai.com/api/docs/pricing"
    },
    "gpt-4o-2024-08-06": {
      "inputUsdPerMillion": 2.5,
      "outputUsdPerMillion": 10,
      "cacheReadUsdPerMillion": 1.25,
      "provider": "openai",
      "sourceUrl": "https://developers.openai.com/api/docs/pricing"
    },
    "gpt-4o-2024-11-20": {
      "inputUsdPerMillion": 2.5,
      "outputUsdPerMillion": 10,
      "cacheReadUsdPerMillion": 1.25,
      "provider": "openai",
      "sourceUrl": "https://developers.openai.com/api/docs/pricing"
    },
    "gpt-4o-audio-preview-2024-12-17": {
      "inputUsdPerMillion": 2.5,
      "outputUsdPerMillion": 10,
      "provider": "openai"
    },
    "gpt-4o-audio-preview-2025-06-03": {
      "inputUsdPerMillion": 2.5,
      "outputUsdPerMillion": 10,
      "provider": "openai"
    },
    "gpt-audio": {
      "inputUsdPerMillion": 2.5,
      "outputUsdPerMillion": 10,
      "provider": "openai",
      "sourceUrl": "https://developers.openai.com/api/docs/pricing"
    },
    "gpt-audio-1.5": {
      "inputUsdPerMillion": 2.5,
      "outputUsdPerMillion": 10,
      "provider": "openai",
      "sourceUrl": "https://developers.openai.com/api/docs/pricing"
    },
    "gpt-audio-2025-08-28": {
      "inputUsdPerMillion": 2.5,
      "outputUsdPerMillion": 10,
      "provider": "openai",
      "sourceUrl": "https://developers.openai.com/api/docs/pricing"
    },
    "gpt-audio-mini": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 2.4,
      "provider": "openai",
      "sourceUrl": "https://developers.openai.com/api/docs/pricing"
    },
    "gpt-audio-mini-2025-12-15": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 2.4,
      "provider": "openai",
      "sourceUrl": "https://developers.openai.com/api/docs/pricing"
    },
    "gpt-4o-mini": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.6,
      "cacheReadUsdPerMillion": 0.075,
      "provider": "openai",
      "sourceUrl": "https://developers.openai.com/api/docs/pricing"
    },
    "gpt-4o-mini-2024-07-18": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.6,
      "cacheReadUsdPerMillion": 0.075,
      "provider": "openai",
      "sourceUrl": "https://developers.openai.com/api/docs/pricing"
    },
    "gpt-4o-mini-audio-preview-2024-12-17": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.6,
      "provider": "openai"
    },
    "gpt-4o-mini-search-preview": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.6,
      "cacheReadUsdPerMillion": 0.075,
      "provider": "openai"
    },
    "gpt-4o-search-preview": {
      "inputUsdPerMillion": 2.5,
      "outputUsdPerMillion": 10,
      "cacheReadUsdPerMillion": 1.25,
      "provider": "openai"
    },
    "gpt-5": {
      "inputUsdPerMillion": 1.25,
      "outputUsdPerMillion": 10,
      "cacheReadUsdPerMillion": 0.125,
      "provider": "openai",
      "sourceUrl": "https://developers.openai.com/api/docs/pricing"
    },
    "gpt-5.1": {
      "inputUsdPerMillion": 1.25,
      "outputUsdPerMillion": 10,
      "cacheReadUsdPerMillion": 0.125,
      "provider": "openai",
      "sourceUrl": "https://developers.openai.com/api/docs/pricing"
    },
    "gpt-5.1-chat-latest": {
      "inputUsdPerMillion": 1.25,
      "outputUsdPerMillion": 10,
      "cacheReadUsdPerMillion": 0.125,
      "provider": "openai",
      "sourceUrl": "https://developers.openai.com/api/docs/models/gpt-5.1-chat-latest"
    },
    "gpt-5.1-2025-11-13": {
      "inputUsdPerMillion": 1.25,
      "outputUsdPerMillion": 10,
      "cacheReadUsdPerMillion": 0.125,
      "provider": "openai",
      "sourceUrl": "https://developers.openai.com/api/docs/pricing"
    },
    "gpt-5.2": {
      "inputUsdPerMillion": 1.75,
      "outputUsdPerMillion": 14,
      "cacheReadUsdPerMillion": 0.175,
      "provider": "openai",
      "sourceUrl": "https://developers.openai.com/api/docs/pricing"
    },
    "gpt-5.2-chat-latest": {
      "inputUsdPerMillion": 1.75,
      "outputUsdPerMillion": 14,
      "cacheReadUsdPerMillion": 0.175,
      "provider": "openai",
      "sourceUrl": "https://developers.openai.com/api/docs/models/gpt-5.2-chat-latest"
    },
    "gpt-5.2-2025-12-11": {
      "inputUsdPerMillion": 1.75,
      "outputUsdPerMillion": 14,
      "cacheReadUsdPerMillion": 0.175,
      "provider": "openai",
      "sourceUrl": "https://developers.openai.com/api/docs/pricing"
    },
    "gpt-6-astra": {
      "inputUsdPerMillion": 10,
      "outputUsdPerMillion": 50,
      "cacheReadUsdPerMillion": 1,
      "cacheWriteUsdPerMillion": 12.5,
      "provider": "openai",
      "sourceUrl": "https://developers.openai.com/api/docs/pricing"
    },
    "gpt-6-sol": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 10,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "cacheWriteUsdPerMillion": 2.5,
      "provider": "openai",
      "sourceUrl": "https://developers.openai.com/api/docs/pricing"
    },
    "gpt-6-luna": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.5,
      "cacheReadUsdPerMillion": 0.01,
      "cacheWriteUsdPerMillion": 0.125,
      "provider": "openai",
      "sourceUrl": "https://developers.openai.com/api/docs/pricing"
    },
    "gpt-5.6": {
      "inputUsdPerMillion": 4,
      "outputUsdPerMillion": 20,
      "cacheReadUsdPerMillion": 0.39999999999999997,
      "cacheWriteUsdPerMillion": 5,
      "provider": "openai"
    },
    "gpt-5.6-sol": {
      "inputUsdPerMillion": 4,
      "outputUsdPerMillion": 20,
      "cacheReadUsdPerMillion": 0.39999999999999997,
      "cacheWriteUsdPerMillion": 5,
      "provider": "openai",
      "sourceUrl": "https://developers.openai.com/api/docs/pricing"
    },
    "gpt-5.6-terra": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 12,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "cacheWriteUsdPerMillion": 2.5,
      "provider": "openai",
      "sourceUrl": "https://developers.openai.com/api/docs/pricing"
    },
    "gpt-5.6-luna": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 1.2,
      "cacheReadUsdPerMillion": 0.02,
      "cacheWriteUsdPerMillion": 0.25,
      "provider": "openai",
      "sourceUrl": "https://developers.openai.com/api/docs/pricing"
    },
    "gpt-5.6-cyber": {
      "inputUsdPerMillion": 12.5,
      "outputUsdPerMillion": 75,
      "cacheReadUsdPerMillion": 1.25,
      "cacheWriteUsdPerMillion": 15.625,
      "provider": "openai",
      "sourceUrl": "https://developers.openai.com/api/docs/pricing"
    },
    "daybreak-red-latest": {
      "inputUsdPerMillion": 12.5,
      "outputUsdPerMillion": 75,
      "cacheReadUsdPerMillion": 1.25,
      "cacheWriteUsdPerMillion": 15.625,
      "provider": "openai",
      "sourceUrl": "https://developers.openai.com/api/docs/models/gpt-daybreak-red-latest"
    },
    "daybreak-blue-latest": {
      "inputUsdPerMillion": 4,
      "outputUsdPerMillion": 20,
      "cacheReadUsdPerMillion": 0.39999999999999997,
      "cacheWriteUsdPerMillion": 5,
      "provider": "openai",
      "sourceUrl": "https://developers.openai.com/api/docs/models/gpt-daybreak-blue-latest"
    },
    "chat-latest": {
      "inputUsdPerMillion": 5,
      "outputUsdPerMillion": 30,
      "cacheReadUsdPerMillion": 0.5,
      "provider": "openai",
      "sourceUrl": "https://developers.openai.com/api/docs/pricing"
    },
    "gpt-5.5": {
      "inputUsdPerMillion": 5,
      "outputUsdPerMillion": 30,
      "cacheReadUsdPerMillion": 0.5,
      "provider": "openai",
      "sourceUrl": "https://developers.openai.com/api/docs/pricing"
    },
    "gpt-5.5-2026-04-23": {
      "inputUsdPerMillion": 5,
      "outputUsdPerMillion": 30,
      "cacheReadUsdPerMillion": 0.5,
      "provider": "openai",
      "sourceUrl": "https://developers.openai.com/api/docs/pricing"
    },
    "gpt-5.4": {
      "inputUsdPerMillion": 2.5,
      "outputUsdPerMillion": 15,
      "cacheReadUsdPerMillion": 0.25,
      "provider": "openai",
      "sourceUrl": "https://developers.openai.com/api/docs/pricing"
    },
    "gpt-5.4-2026-03-05": {
      "inputUsdPerMillion": 2.5,
      "outputUsdPerMillion": 15,
      "cacheReadUsdPerMillion": 0.25,
      "provider": "openai",
      "sourceUrl": "https://developers.openai.com/api/docs/pricing"
    },
    "gpt-5.4-mini": {
      "inputUsdPerMillion": 0.75,
      "outputUsdPerMillion": 4.5,
      "cacheReadUsdPerMillion": 0.075,
      "provider": "openai",
      "sourceUrl": "https://developers.openai.com/api/docs/pricing"
    },
    "gpt-5.4-mini-2026-03-17": {
      "inputUsdPerMillion": 0.75,
      "outputUsdPerMillion": 4.5,
      "cacheReadUsdPerMillion": 0.075,
      "provider": "openai",
      "sourceUrl": "https://developers.openai.com/api/docs/pricing"
    },
    "gpt-5.4-nano": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 1.25,
      "cacheReadUsdPerMillion": 0.02,
      "provider": "openai",
      "sourceUrl": "https://developers.openai.com/api/docs/pricing"
    },
    "gpt-5.4-nano-2026-03-17": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 1.25,
      "cacheReadUsdPerMillion": 0.02,
      "provider": "openai",
      "sourceUrl": "https://developers.openai.com/api/docs/pricing"
    },
    "gpt-5-2025-08-07": {
      "inputUsdPerMillion": 1.25,
      "outputUsdPerMillion": 10,
      "cacheReadUsdPerMillion": 0.125,
      "provider": "openai",
      "sourceUrl": "https://developers.openai.com/api/docs/pricing"
    },
    "gpt-5-chat": {
      "inputUsdPerMillion": 1.25,
      "outputUsdPerMillion": 10,
      "cacheReadUsdPerMillion": 0.125,
      "provider": "openai"
    },
    "gpt-5-chat-latest": {
      "inputUsdPerMillion": 1.25,
      "outputUsdPerMillion": 10,
      "cacheReadUsdPerMillion": 0.125,
      "provider": "openai",
      "sourceUrl": "https://developers.openai.com/api/docs/models/gpt-5-chat-latest"
    },
    "gpt-5.3-chat-latest": {
      "inputUsdPerMillion": 1.75,
      "outputUsdPerMillion": 14,
      "cacheReadUsdPerMillion": 0.175,
      "provider": "openai",
      "sourceUrl": "https://developers.openai.com/api/docs/models/gpt-5.3-chat-latest"
    },
    "gpt-5-mini": {
      "inputUsdPerMillion": 0.25,
      "outputUsdPerMillion": 2,
      "cacheReadUsdPerMillion": 0.024999999999999998,
      "provider": "openai",
      "sourceUrl": "https://developers.openai.com/api/docs/pricing"
    },
    "gpt-5-mini-2025-08-07": {
      "inputUsdPerMillion": 0.25,
      "outputUsdPerMillion": 2,
      "cacheReadUsdPerMillion": 0.024999999999999998,
      "provider": "openai",
      "sourceUrl": "https://developers.openai.com/api/docs/pricing"
    },
    "gpt-5-nano": {
      "inputUsdPerMillion": 0.049999999999999996,
      "outputUsdPerMillion": 0.39999999999999997,
      "cacheReadUsdPerMillion": 0.005,
      "provider": "openai",
      "sourceUrl": "https://developers.openai.com/api/docs/pricing"
    },
    "gpt-5-nano-2025-08-07": {
      "inputUsdPerMillion": 0.049999999999999996,
      "outputUsdPerMillion": 0.39999999999999997,
      "cacheReadUsdPerMillion": 0.005,
      "provider": "openai",
      "sourceUrl": "https://developers.openai.com/api/docs/pricing"
    },
    "gradient_ai/anthropic-claude-3-opus": {
      "inputUsdPerMillion": 15,
      "outputUsdPerMillion": 75,
      "provider": "gradient_ai"
    },
    "gradient_ai/anthropic-claude-3.5-haiku": {
      "inputUsdPerMillion": 0.7999999999999999,
      "outputUsdPerMillion": 4,
      "provider": "gradient_ai"
    },
    "gradient_ai/anthropic-claude-3.5-sonnet": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 15,
      "provider": "gradient_ai"
    },
    "gradient_ai/anthropic-claude-3.7-sonnet": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 15,
      "provider": "gradient_ai"
    },
    "gradient_ai/deepseek-r1-distill-llama-70b": {
      "inputUsdPerMillion": 0.9900000000000001,
      "outputUsdPerMillion": 0.9900000000000001,
      "provider": "gradient_ai"
    },
    "gradient_ai/llama3-8b-instruct": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "gradient_ai"
    },
    "gradient_ai/llama3.3-70b-instruct": {
      "inputUsdPerMillion": 0.65,
      "outputUsdPerMillion": 0.65,
      "provider": "gradient_ai"
    },
    "gradient_ai/mistral-nemo-instruct-2407": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 0.3,
      "provider": "gradient_ai"
    },
    "gradient_ai/openai-o3": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 8,
      "provider": "gradient_ai"
    },
    "gradient_ai/openai-o3-mini": {
      "inputUsdPerMillion": 1.1,
      "outputUsdPerMillion": 4.4,
      "provider": "gradient_ai"
    },
    "lemonade/Qwen3-Coder-30B-A3B-Instruct-GGUF": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "lemonade"
    },
    "lemonade/gpt-oss-20b-mxfp4-GGUF": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "lemonade"
    },
    "lemonade/gpt-oss-120b-mxfp-GGUF": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "lemonade"
    },
    "lemonade/Gemma-3-4b-it-GGUF": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "lemonade"
    },
    "lemonade/Qwen3-4B-Instruct-2507-GGUF": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "lemonade"
    },
    "amazon-nova/nova-micro-v1": {
      "inputUsdPerMillion": 0.035,
      "outputUsdPerMillion": 0.14,
      "provider": "amazon_nova"
    },
    "amazon-nova/nova-lite-v1": {
      "inputUsdPerMillion": 0.06,
      "outputUsdPerMillion": 0.24,
      "provider": "amazon_nova"
    },
    "amazon-nova/nova-premier-v1": {
      "inputUsdPerMillion": 2.5,
      "outputUsdPerMillion": 12.5,
      "provider": "amazon_nova"
    },
    "amazon-nova/nova-pro-v1": {
      "inputUsdPerMillion": 0.7999999999999999,
      "outputUsdPerMillion": 3.1999999999999997,
      "provider": "amazon_nova"
    },
    "groq/llama-guard-3-8b": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "groq",
      "sourceUrl": "https://console.groq.com/docs/model/llama-guard-3-8b"
    },
    "groq/meta-llama/llama-prompt-guard-2-22m": {
      "inputUsdPerMillion": 0.03,
      "outputUsdPerMillion": 0.03,
      "provider": "groq",
      "sourceUrl": "https://console.groq.com/docs/models"
    },
    "groq/meta-llama/llama-prompt-guard-2-86m": {
      "inputUsdPerMillion": 0.04,
      "outputUsdPerMillion": 0.04,
      "provider": "groq",
      "sourceUrl": "https://console.groq.com/docs/model/meta-llama/llama-prompt-guard-2-86m"
    },
    "groq/openai/gpt-oss-120b": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.6,
      "cacheReadUsdPerMillion": 0.075,
      "provider": "groq"
    },
    "groq/openai/gpt-oss-20b": {
      "inputUsdPerMillion": 0.075,
      "outputUsdPerMillion": 0.3,
      "cacheReadUsdPerMillion": 0.0375,
      "provider": "groq"
    },
    "groq/openai/gpt-oss-safeguard-20b": {
      "inputUsdPerMillion": 0.075,
      "outputUsdPerMillion": 0.3,
      "cacheReadUsdPerMillion": 0.037,
      "provider": "groq"
    },
    "hyperbolic/NousResearch/Hermes-3-Llama-3.1-70B": {
      "inputUsdPerMillion": 0.12,
      "outputUsdPerMillion": 0.3,
      "provider": "hyperbolic"
    },
    "hyperbolic/Qwen/QwQ-32B": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "hyperbolic"
    },
    "hyperbolic/Qwen/Qwen2.5-72B-Instruct": {
      "inputUsdPerMillion": 0.12,
      "outputUsdPerMillion": 0.3,
      "provider": "hyperbolic"
    },
    "hyperbolic/Qwen/Qwen2.5-Coder-32B-Instruct": {
      "inputUsdPerMillion": 0.12,
      "outputUsdPerMillion": 0.3,
      "provider": "hyperbolic"
    },
    "hyperbolic/Qwen/Qwen3-235B-A22B": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 2,
      "provider": "hyperbolic"
    },
    "hyperbolic/deepseek-ai/DeepSeek-R1": {
      "inputUsdPerMillion": 0.39999999999999997,
      "outputUsdPerMillion": 0.39999999999999997,
      "provider": "hyperbolic"
    },
    "hyperbolic/deepseek-ai/DeepSeek-R1-0528": {
      "inputUsdPerMillion": 0.25,
      "outputUsdPerMillion": 0.25,
      "provider": "hyperbolic"
    },
    "hyperbolic/deepseek-ai/DeepSeek-V3": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "hyperbolic"
    },
    "hyperbolic/deepseek-ai/DeepSeek-V3-0324": {
      "inputUsdPerMillion": 0.39999999999999997,
      "outputUsdPerMillion": 0.39999999999999997,
      "provider": "hyperbolic"
    },
    "hyperbolic/meta-llama/Llama-3.2-3B-Instruct": {
      "inputUsdPerMillion": 0.12,
      "outputUsdPerMillion": 0.3,
      "provider": "hyperbolic"
    },
    "hyperbolic/meta-llama/Llama-3.3-70B-Instruct": {
      "inputUsdPerMillion": 0.12,
      "outputUsdPerMillion": 0.3,
      "provider": "hyperbolic"
    },
    "hyperbolic/meta-llama/Meta-Llama-3-70B-Instruct": {
      "inputUsdPerMillion": 0.12,
      "outputUsdPerMillion": 0.3,
      "provider": "hyperbolic"
    },
    "hyperbolic/meta-llama/Meta-Llama-3.1-405B-Instruct": {
      "inputUsdPerMillion": 0.12,
      "outputUsdPerMillion": 0.3,
      "provider": "hyperbolic"
    },
    "hyperbolic/meta-llama/Meta-Llama-3.1-70B-Instruct": {
      "inputUsdPerMillion": 0.12,
      "outputUsdPerMillion": 0.3,
      "provider": "hyperbolic"
    },
    "hyperbolic/meta-llama/Meta-Llama-3.1-8B-Instruct": {
      "inputUsdPerMillion": 0.12,
      "outputUsdPerMillion": 0.3,
      "provider": "hyperbolic"
    },
    "hyperbolic/moonshotai/Kimi-K2-Instruct": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 2,
      "provider": "hyperbolic"
    },
    "j2-light": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 3,
      "provider": "ai21"
    },
    "j2-mid": {
      "inputUsdPerMillion": 10,
      "outputUsdPerMillion": 10,
      "provider": "ai21"
    },
    "j2-ultra": {
      "inputUsdPerMillion": 15,
      "outputUsdPerMillion": 15,
      "provider": "ai21"
    },
    "jamba-1.5": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.39999999999999997,
      "provider": "ai21"
    },
    "jamba-1.5-large": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 8,
      "provider": "ai21"
    },
    "jamba-1.5-large@001": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 8,
      "provider": "ai21"
    },
    "jamba-1.5-mini": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.39999999999999997,
      "provider": "ai21"
    },
    "jamba-1.5-mini@001": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.39999999999999997,
      "provider": "ai21"
    },
    "jamba-large-1.6": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 8,
      "provider": "ai21"
    },
    "jamba-large-1.7": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 8,
      "provider": "ai21"
    },
    "jamba-mini-1.6": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.39999999999999997,
      "provider": "ai21"
    },
    "jamba-mini-1.7": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.39999999999999997,
      "provider": "ai21"
    },
    "jp.anthropic.claude-sonnet-4-5-20250929-v1:0": {
      "inputUsdPerMillion": 3.3000000000000003,
      "outputUsdPerMillion": 16.5,
      "cacheReadUsdPerMillion": 0.33,
      "cacheWriteUsdPerMillion": 4.125,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "jp.anthropic.claude-haiku-4-5-20251001-v1:0": {
      "inputUsdPerMillion": 1.1,
      "outputUsdPerMillion": 5.5,
      "cacheReadUsdPerMillion": 0.11,
      "cacheWriteUsdPerMillion": 1.375,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "crusoe/deepseek-ai/DeepSeek-R1-0528": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 7,
      "provider": "crusoe"
    },
    "crusoe/deepseek-ai/DeepSeek-V3-0324": {
      "inputUsdPerMillion": 1.5,
      "outputUsdPerMillion": 1.5,
      "provider": "crusoe"
    },
    "crusoe/google/gemma-3-12b-it": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.09999999999999999,
      "provider": "crusoe"
    },
    "crusoe/meta-llama/Llama-3.3-70B-Instruct": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "crusoe"
    },
    "crusoe/moonshotai/Kimi-K2-Thinking": {
      "inputUsdPerMillion": 2.5,
      "outputUsdPerMillion": 2.5,
      "provider": "crusoe"
    },
    "crusoe/openai/gpt-oss-120b": {
      "inputUsdPerMillion": 0.7999999999999999,
      "outputUsdPerMillion": 0.7999999999999999,
      "provider": "crusoe"
    },
    "crusoe/Qwen/Qwen3-235B-A22B-Instruct-2507": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 3,
      "provider": "crusoe"
    },
    "inception/mercury-2": {
      "inputUsdPerMillion": 0.25,
      "outputUsdPerMillion": 0.75,
      "cacheReadUsdPerMillion": 0.024999999999999998,
      "provider": "inception"
    },
    "inception/mercury-2.5": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.75,
      "cacheReadUsdPerMillion": 0.02,
      "provider": "inception",
      "sourceUrl": "https://docs.inceptionlabs.ai/get-started/models"
    },
    "text-completion-inception/mercury-edit-2": {
      "inputUsdPerMillion": 0.25,
      "outputUsdPerMillion": 0.75,
      "cacheReadUsdPerMillion": 0.024999999999999998,
      "provider": "text-completion-inception"
    },
    "lambda_ai/deepseek-llama3.3-70b": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.6,
      "provider": "lambda_ai"
    },
    "lambda_ai/deepseek-r1-0528": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.6,
      "provider": "lambda_ai"
    },
    "lambda_ai/deepseek-r1-671b": {
      "inputUsdPerMillion": 0.7999999999999999,
      "outputUsdPerMillion": 0.7999999999999999,
      "provider": "lambda_ai"
    },
    "lambda_ai/deepseek-v3-0324": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.6,
      "provider": "lambda_ai"
    },
    "lambda_ai/hermes3-405b": {
      "inputUsdPerMillion": 0.7999999999999999,
      "outputUsdPerMillion": 0.7999999999999999,
      "provider": "lambda_ai"
    },
    "lambda_ai/hermes3-70b": {
      "inputUsdPerMillion": 0.12,
      "outputUsdPerMillion": 0.3,
      "provider": "lambda_ai"
    },
    "lambda_ai/hermes3-8b": {
      "inputUsdPerMillion": 0.024999999999999998,
      "outputUsdPerMillion": 0.04,
      "provider": "lambda_ai"
    },
    "lambda_ai/lfm-40b": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "lambda_ai"
    },
    "lambda_ai/lfm-7b": {
      "inputUsdPerMillion": 0.024999999999999998,
      "outputUsdPerMillion": 0.04,
      "provider": "lambda_ai"
    },
    "lambda_ai/llama-4-maverick-17b-128e-instruct-fp8": {
      "inputUsdPerMillion": 0.049999999999999996,
      "outputUsdPerMillion": 0.09999999999999999,
      "provider": "lambda_ai"
    },
    "lambda_ai/llama-4-scout-17b-16e-instruct": {
      "inputUsdPerMillion": 0.049999999999999996,
      "outputUsdPerMillion": 0.09999999999999999,
      "provider": "lambda_ai"
    },
    "lambda_ai/llama3.1-405b-instruct-fp8": {
      "inputUsdPerMillion": 0.7999999999999999,
      "outputUsdPerMillion": 0.7999999999999999,
      "provider": "lambda_ai"
    },
    "lambda_ai/llama3.1-70b-instruct-fp8": {
      "inputUsdPerMillion": 0.12,
      "outputUsdPerMillion": 0.3,
      "provider": "lambda_ai"
    },
    "lambda_ai/llama3.1-8b-instruct": {
      "inputUsdPerMillion": 0.024999999999999998,
      "outputUsdPerMillion": 0.04,
      "provider": "lambda_ai"
    },
    "lambda_ai/llama3.1-nemotron-70b-instruct-fp8": {
      "inputUsdPerMillion": 0.12,
      "outputUsdPerMillion": 0.3,
      "provider": "lambda_ai"
    },
    "lambda_ai/llama3.2-11b-vision-instruct": {
      "inputUsdPerMillion": 0.015,
      "outputUsdPerMillion": 0.024999999999999998,
      "provider": "lambda_ai"
    },
    "lambda_ai/llama3.2-3b-instruct": {
      "inputUsdPerMillion": 0.015,
      "outputUsdPerMillion": 0.024999999999999998,
      "provider": "lambda_ai"
    },
    "lambda_ai/llama3.3-70b-instruct-fp8": {
      "inputUsdPerMillion": 0.12,
      "outputUsdPerMillion": 0.3,
      "provider": "lambda_ai"
    },
    "lambda_ai/qwen25-coder-32b-instruct": {
      "inputUsdPerMillion": 0.049999999999999996,
      "outputUsdPerMillion": 0.09999999999999999,
      "provider": "lambda_ai"
    },
    "lambda_ai/qwen3-32b-fp8": {
      "inputUsdPerMillion": 0.049999999999999996,
      "outputUsdPerMillion": 0.09999999999999999,
      "provider": "lambda_ai"
    },
    "meta.llama2-13b-chat-v1": {
      "inputUsdPerMillion": 0.75,
      "outputUsdPerMillion": 1,
      "provider": "bedrock",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "meta.llama2-70b-chat-v1": {
      "inputUsdPerMillion": 1.95,
      "outputUsdPerMillion": 2.56,
      "provider": "bedrock",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "meta.llama3-1-405b-instruct-v1:0": {
      "inputUsdPerMillion": 2.4,
      "outputUsdPerMillion": 2.4,
      "provider": "bedrock",
      "sourceUrl": "https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/bedrock/USD/current/bedrock.json"
    },
    "meta.llama3-1-70b-instruct-v1:0": {
      "inputUsdPerMillion": 0.72,
      "outputUsdPerMillion": 0.72,
      "provider": "bedrock",
      "sourceUrl": "https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/bedrock/USD/current/bedrock.json"
    },
    "meta.llama3-1-8b-instruct-v1:0": {
      "inputUsdPerMillion": 0.22,
      "outputUsdPerMillion": 0.22,
      "provider": "bedrock"
    },
    "meta.llama3-2-11b-instruct-v1:0": {
      "inputUsdPerMillion": 0.16,
      "outputUsdPerMillion": 0.16,
      "provider": "bedrock",
      "sourceUrl": "https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/bedrock/USD/current/bedrock.json"
    },
    "meta.llama3-2-1b-instruct-v1:0": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.09999999999999999,
      "provider": "bedrock"
    },
    "meta.llama3-2-3b-instruct-v1:0": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.15,
      "provider": "bedrock"
    },
    "meta.llama3-2-90b-instruct-v1:0": {
      "inputUsdPerMillion": 0.72,
      "outputUsdPerMillion": 0.72,
      "provider": "bedrock",
      "sourceUrl": "https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/bedrock/USD/current/bedrock.json"
    },
    "meta.llama3-3-70b-instruct-v1:0": {
      "inputUsdPerMillion": 0.72,
      "outputUsdPerMillion": 0.72,
      "provider": "bedrock_converse"
    },
    "meta.llama3-70b-instruct-v1:0": {
      "inputUsdPerMillion": 2.65,
      "outputUsdPerMillion": 3.5,
      "provider": "bedrock"
    },
    "meta.llama3-8b-instruct-v1:0": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 0.6,
      "provider": "bedrock"
    },
    "meta.llama4-maverick-17b-instruct-v1:0": {
      "inputUsdPerMillion": 0.24,
      "outputUsdPerMillion": 0.9700000000000001,
      "provider": "bedrock_converse"
    },
    "meta.llama4-scout-17b-instruct-v1:0": {
      "inputUsdPerMillion": 0.16999999999999998,
      "outputUsdPerMillion": 0.66,
      "provider": "bedrock_converse"
    },
    "meta/muse-spark-1.1": {
      "inputUsdPerMillion": 1.25,
      "outputUsdPerMillion": 4.25,
      "cacheReadUsdPerMillion": 0.15,
      "provider": "meta",
      "sourceUrl": "https://ai.developer.meta.com/docs/pricing-rate-limits"
    },
    "meta/muse-spark-1.2": {
      "inputUsdPerMillion": 1.25,
      "outputUsdPerMillion": 4.25,
      "cacheReadUsdPerMillion": 0.15,
      "provider": "meta",
      "sourceUrl": "https://ai.developer.meta.com/docs/pricing-rate-limits"
    },
    "meta/muse-spark-1.2-contributor": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.19999999999999998,
      "cacheReadUsdPerMillion": 0.002,
      "provider": "meta",
      "sourceUrl": "https://ai.developer.meta.com/docs/pricing-rate-limits"
    },
    "meta/muse-spark-1.3": {
      "inputUsdPerMillion": 1.25,
      "outputUsdPerMillion": 4.25,
      "cacheReadUsdPerMillion": 0.15,
      "provider": "meta",
      "sourceUrl": "https://ai.developer.meta.com/docs/pricing-rate-limits"
    },
    "meta/muse-spark-1.3-contributor": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.19999999999999998,
      "cacheReadUsdPerMillion": 0.002,
      "provider": "meta",
      "sourceUrl": "https://ai.developer.meta.com/docs/pricing-rate-limits"
    },
    "minimax.minimax-m2": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 1.2,
      "provider": "bedrock_converse",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-minimax-minimax-m2.html"
    },
    "minimax.minimax-m2.1": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 1.2,
      "provider": "bedrock_converse",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-minimax-minimax-m2-1.html"
    },
    "minimax.minimax-m2.5": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 1.2,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "minimax/MiniMax-M2.1": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 1.2,
      "cacheReadUsdPerMillion": 0.03,
      "cacheWriteUsdPerMillion": 0.375,
      "provider": "minimax"
    },
    "minimax/MiniMax-M2.1-lightning": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 2.4,
      "cacheReadUsdPerMillion": 0.03,
      "cacheWriteUsdPerMillion": 0.375,
      "provider": "minimax"
    },
    "minimax/MiniMax-M2.5": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 1.2,
      "cacheReadUsdPerMillion": 0.03,
      "cacheWriteUsdPerMillion": 0.375,
      "provider": "minimax"
    },
    "minimax/MiniMax-M2.5-lightning": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 2.4,
      "cacheReadUsdPerMillion": 0.03,
      "cacheWriteUsdPerMillion": 0.375,
      "provider": "minimax"
    },
    "minimax/MiniMax-M2": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 1.2,
      "cacheReadUsdPerMillion": 0.03,
      "cacheWriteUsdPerMillion": 0.375,
      "provider": "minimax"
    },
    "minimax/MiniMax-M3": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 1.2,
      "cacheReadUsdPerMillion": 0.06,
      "provider": "minimax"
    },
    "mistral.devstral-2-123b": {
      "inputUsdPerMillion": 0.39999999999999997,
      "outputUsdPerMillion": 2,
      "provider": "bedrock_converse",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-mistral-ai-devstral-2-123b.html"
    },
    "mistral.magistral-small-2509": {
      "inputUsdPerMillion": 0.5,
      "outputUsdPerMillion": 1.5,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "mistral.ministral-3-14b-instruct": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "mistral.ministral-3-3b-instruct": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.09999999999999999,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "mistral.ministral-3-8b-instruct": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.15,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "mistral.mistral-7b-instruct-v0:2": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "bedrock",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "mistral.mistral-large-2402-v1:0": {
      "inputUsdPerMillion": 4,
      "outputUsdPerMillion": 12,
      "provider": "bedrock",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "mistral.mistral-large-2407-v1:0": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 6,
      "provider": "bedrock",
      "sourceUrl": "https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/bedrock/USD/current/bedrock.json"
    },
    "mistral.mistral-large-3-675b-instruct": {
      "inputUsdPerMillion": 0.5,
      "outputUsdPerMillion": 1.5,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "mistral.mistral-small-2402-v1:0": {
      "inputUsdPerMillion": 1,
      "outputUsdPerMillion": 3,
      "provider": "bedrock",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "mistral.mixtral-8x7b-instruct-v0:1": {
      "inputUsdPerMillion": 0.44999999999999996,
      "outputUsdPerMillion": 0.7,
      "provider": "bedrock",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "mistral.voxtral-mini-3b-2507": {
      "inputUsdPerMillion": 0.04,
      "outputUsdPerMillion": 0.04,
      "provider": "bedrock_converse",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-mistral-ai-voxtral-mini-3b-2507.html"
    },
    "mistral.voxtral-small-24b-2507": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.3,
      "provider": "bedrock_converse",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-mistral-ai-voxtral-small-24b-2507.html"
    },
    "mistral/codestral-2508": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 0.8999999999999999,
      "cacheReadUsdPerMillion": 0.03,
      "provider": "mistral",
      "sourceUrl": "https://docs.mistral.ai/models/model-cards/codestral-25-08"
    },
    "mistral/codestral-latest": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 0.8999999999999999,
      "cacheReadUsdPerMillion": 0.03,
      "provider": "mistral",
      "sourceUrl": "https://docs.mistral.ai/models/model-cards/codestral-25-08"
    },
    "mistral/codestral-mamba-latest": {
      "inputUsdPerMillion": 0.25,
      "outputUsdPerMillion": 0.25,
      "cacheReadUsdPerMillion": 0.024999999999999998,
      "provider": "mistral",
      "sourceUrl": "https://mistral.ai/technology/"
    },
    "mistral/devstral-small-latest": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.3,
      "cacheReadUsdPerMillion": 0.01,
      "provider": "mistral",
      "sourceUrl": "https://docs.mistral.ai/models/devstral-small-2-25-12"
    },
    "mistral/devstral-latest": {
      "inputUsdPerMillion": 0.39999999999999997,
      "outputUsdPerMillion": 2,
      "cacheReadUsdPerMillion": 0.04,
      "provider": "mistral",
      "sourceUrl": "https://mistral.ai/news/devstral-2-vibe-cli"
    },
    "mistral/devstral-medium-latest": {
      "inputUsdPerMillion": 0.39999999999999997,
      "outputUsdPerMillion": 2,
      "cacheReadUsdPerMillion": 0.04,
      "provider": "mistral",
      "sourceUrl": "https://mistral.ai/news/devstral-2-vibe-cli"
    },
    "mistral/ministral-14b-2512": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "cacheReadUsdPerMillion": 0.02,
      "provider": "mistral",
      "sourceUrl": "https://docs.mistral.ai/models/ministral-3-14b-25-12"
    },
    "mistral/ministral-14b-latest": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "cacheReadUsdPerMillion": 0.02,
      "provider": "mistral",
      "sourceUrl": "https://docs.mistral.ai/models/ministral-3-14b-25-12"
    },
    "mistral/ministral-3b-2512": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.09999999999999999,
      "cacheReadUsdPerMillion": 0.01,
      "provider": "mistral",
      "sourceUrl": "https://docs.mistral.ai/models/ministral-3-3b-25-12"
    },
    "mistral/ministral-3b-latest": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.09999999999999999,
      "cacheReadUsdPerMillion": 0.01,
      "provider": "mistral",
      "sourceUrl": "https://docs.mistral.ai/models/ministral-3-3b-25-12"
    },
    "mistral/mistral-medium-3": {
      "inputUsdPerMillion": 1.5,
      "outputUsdPerMillion": 7.5,
      "cacheReadUsdPerMillion": 0.15,
      "provider": "mistral",
      "sourceUrl": "https://docs.mistral.ai/models/model-cards/mistral-medium-3-5-26-04"
    },
    "mistral/voxtral-small-2507": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.39999999999999997,
      "cacheReadUsdPerMillion": 0.01,
      "provider": "mistral",
      "sourceUrl": "https://docs.mistral.ai/models/voxtral-small-25-07"
    },
    "mistral/voxtral-small-latest": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.39999999999999997,
      "cacheReadUsdPerMillion": 0.01,
      "provider": "mistral",
      "sourceUrl": "https://docs.mistral.ai/models/voxtral-small-25-07"
    },
    "mistral/zai-glm-5-2": {
      "inputUsdPerMillion": 1.4,
      "outputUsdPerMillion": 4.4,
      "cacheReadUsdPerMillion": 0.14,
      "provider": "mistral",
      "sourceUrl": "https://docs.mistral.ai/models/zai-glm-5-2"
    },
    "mistral/zai-glm-5-3": {
      "inputUsdPerMillion": 1.4,
      "outputUsdPerMillion": 4.4,
      "cacheReadUsdPerMillion": 0.14,
      "provider": "mistral",
      "sourceUrl": "https://docs.mistral.ai/models/zai-glm-5-3"
    },
    "mistral/zai-glm-5": {
      "inputUsdPerMillion": 1.4,
      "outputUsdPerMillion": 4.4,
      "cacheReadUsdPerMillion": 0.14,
      "provider": "mistral",
      "sourceUrl": "https://docs.mistral.ai/models/zai-glm-5-3"
    },
    "mistral/zai-glm-latest": {
      "inputUsdPerMillion": 1.4,
      "outputUsdPerMillion": 4.4,
      "cacheReadUsdPerMillion": 0.14,
      "provider": "mistral",
      "sourceUrl": "https://docs.mistral.ai/models/zai-glm-5-3"
    },
    "mistral/glm-5-2": {
      "inputUsdPerMillion": 1.4,
      "outputUsdPerMillion": 4.4,
      "cacheReadUsdPerMillion": 0.14,
      "provider": "mistral",
      "sourceUrl": "https://docs.mistral.ai/models/zai-glm-5-2"
    },
    "mistral/magistral-medium-latest": {
      "inputUsdPerMillion": 1.5,
      "outputUsdPerMillion": 7.5,
      "cacheReadUsdPerMillion": 0.15,
      "provider": "mistral",
      "sourceUrl": "https://docs.mistral.ai/models/model-cards/mistral-medium-3-5-26-04"
    },
    "mistral/magistral-small-latest": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.6,
      "cacheReadUsdPerMillion": 0.015,
      "provider": "mistral",
      "sourceUrl": "https://docs.mistral.ai/models/model-cards/mistral-small-4-0-26-03"
    },
    "mistral/mistral-large-4": {
      "inputUsdPerMillion": 0.6799999999999999,
      "outputUsdPerMillion": 2.09,
      "cacheReadUsdPerMillion": 0.068,
      "provider": "mistral",
      "sourceUrl": "https://docs.mistral.ai/models/mistral-large-4"
    },
    "mistral/mistral-large-4-0": {
      "inputUsdPerMillion": 0.6799999999999999,
      "outputUsdPerMillion": 2.09,
      "cacheReadUsdPerMillion": 0.068,
      "provider": "mistral",
      "sourceUrl": "https://docs.mistral.ai/models/mistral-large-4"
    },
    "mistral/mistral-large-latest": {
      "inputUsdPerMillion": 0.5,
      "outputUsdPerMillion": 1.5,
      "cacheReadUsdPerMillion": 0.049999999999999996,
      "provider": "mistral",
      "sourceUrl": "https://docs.mistral.ai/models/mistral-large-3-25-12"
    },
    "mistral/mistral-large-3": {
      "inputUsdPerMillion": 0.5,
      "outputUsdPerMillion": 1.5,
      "cacheReadUsdPerMillion": 0.049999999999999996,
      "provider": "mistral",
      "sourceUrl": "https://docs.mistral.ai/models/mistral-large-3-25-12"
    },
    "mistral/mistral-large-2512": {
      "inputUsdPerMillion": 0.5,
      "outputUsdPerMillion": 1.5,
      "cacheReadUsdPerMillion": 0.049999999999999996,
      "provider": "mistral",
      "sourceUrl": "https://docs.mistral.ai/models/mistral-large-3-25-12"
    },
    "mistral/mistral-medium": {
      "inputUsdPerMillion": 1.5,
      "outputUsdPerMillion": 7.5,
      "cacheReadUsdPerMillion": 0.15,
      "provider": "mistral",
      "sourceUrl": "https://docs.mistral.ai/models/model-cards/mistral-medium-3-5-26-04"
    },
    "mistral/mistral-medium-2604": {
      "inputUsdPerMillion": 1.5,
      "outputUsdPerMillion": 7.5,
      "cacheReadUsdPerMillion": 0.15,
      "provider": "mistral",
      "sourceUrl": "https://docs.mistral.ai/models/model-cards/mistral-medium-3-5-26-04"
    },
    "mistral/mistral-medium-latest": {
      "inputUsdPerMillion": 1.5,
      "outputUsdPerMillion": 7.5,
      "cacheReadUsdPerMillion": 0.15,
      "provider": "mistral",
      "sourceUrl": "https://docs.mistral.ai/models/model-cards/mistral-medium-3-5-26-04"
    },
    "mistral/mistral-medium-3-5": {
      "inputUsdPerMillion": 1.5,
      "outputUsdPerMillion": 7.5,
      "cacheReadUsdPerMillion": 0.15,
      "provider": "mistral",
      "sourceUrl": "https://docs.mistral.ai/models/model-cards/mistral-medium-3-5-26-04"
    },
    "mistral/mistral-small": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.3,
      "cacheReadUsdPerMillion": 0.01,
      "provider": "mistral"
    },
    "mistral/mistral-small-latest": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.6,
      "cacheReadUsdPerMillion": 0.015,
      "provider": "mistral",
      "sourceUrl": "https://docs.mistral.ai/models/model-cards/mistral-small-4-0-26-03"
    },
    "mistral/ministral-3-3b-2512": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.09999999999999999,
      "cacheReadUsdPerMillion": 0.01,
      "provider": "mistral",
      "sourceUrl": "https://mistral.ai/pricing"
    },
    "mistral/ministral-3-8b-2512": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.15,
      "cacheReadUsdPerMillion": 0.015,
      "provider": "mistral",
      "sourceUrl": "https://mistral.ai/pricing"
    },
    "mistral/ministral-3-14b-2512": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "cacheReadUsdPerMillion": 0.02,
      "provider": "mistral",
      "sourceUrl": "https://mistral.ai/pricing"
    },
    "mistral/ministral-8b-2512": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.15,
      "cacheReadUsdPerMillion": 0.015,
      "provider": "mistral",
      "sourceUrl": "https://mistral.ai/pricing"
    },
    "mistral/ministral-8b-latest": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.15,
      "cacheReadUsdPerMillion": 0.015,
      "provider": "mistral",
      "sourceUrl": "https://mistral.ai/pricing"
    },
    "mistral/mistral-tiny": {
      "inputUsdPerMillion": 0.25,
      "outputUsdPerMillion": 0.25,
      "cacheReadUsdPerMillion": 0.024999999999999998,
      "provider": "mistral"
    },
    "mistral/open-mistral-nemo": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 0.3,
      "cacheReadUsdPerMillion": 0.03,
      "provider": "mistral",
      "sourceUrl": "https://mistral.ai/technology/"
    },
    "mistral/pixtral-large-latest": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 6,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "provider": "mistral"
    },
    "moonshot.kimi-k2-thinking": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 2.5,
      "provider": "bedrock_converse",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-moonshot-ai-kimi-k2-thinking.html"
    },
    "moonshotai.kimi-k2.5": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 3,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "moonshot/kimi-k2.7-code": {
      "inputUsdPerMillion": 0.95,
      "outputUsdPerMillion": 4,
      "cacheReadUsdPerMillion": 0.19,
      "provider": "moonshot",
      "sourceUrl": "https://platform.kimi.ai/docs/pricing/chat-k27-code"
    },
    "moonshot/kimi-k2.5": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 3,
      "cacheReadUsdPerMillion": 0.09999999999999999,
      "provider": "moonshot",
      "sourceUrl": "https://platform.moonshot.ai/docs/guide/kimi-k2-5-quickstart"
    },
    "moonshot/kimi-k2.6": {
      "inputUsdPerMillion": 0.95,
      "outputUsdPerMillion": 4,
      "cacheReadUsdPerMillion": 0.16,
      "provider": "moonshot",
      "sourceUrl": "https://platform.kimi.ai/docs/pricing/chat-k26"
    },
    "moonshot/kimi-k3": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 15,
      "cacheReadUsdPerMillion": 0.3,
      "provider": "moonshot",
      "sourceUrl": "https://platform.kimi.ai/docs/pricing/chat-k3"
    },
    "moonshot/moonshot-v1-128k": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 5,
      "provider": "moonshot",
      "sourceUrl": "https://platform.moonshot.ai/docs/pricing"
    },
    "moonshot/moonshot-v1-128k-vision-preview": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 5,
      "provider": "moonshot",
      "sourceUrl": "https://platform.moonshot.ai/docs/pricing"
    },
    "moonshot/moonshot-v1-32k": {
      "inputUsdPerMillion": 1,
      "outputUsdPerMillion": 3,
      "provider": "moonshot",
      "sourceUrl": "https://platform.moonshot.ai/docs/pricing"
    },
    "moonshot/moonshot-v1-32k-vision-preview": {
      "inputUsdPerMillion": 1,
      "outputUsdPerMillion": 3,
      "provider": "moonshot",
      "sourceUrl": "https://platform.moonshot.ai/docs/pricing"
    },
    "moonshot/moonshot-v1-8k": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 2,
      "provider": "moonshot",
      "sourceUrl": "https://platform.moonshot.ai/docs/pricing"
    },
    "moonshot/moonshot-v1-8k-vision-preview": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 2,
      "provider": "moonshot",
      "sourceUrl": "https://platform.moonshot.ai/docs/pricing"
    },
    "moonshot/moonshot-v1-auto": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 5,
      "provider": "moonshot",
      "sourceUrl": "https://platform.moonshot.ai/docs/pricing"
    },
    "morph/morph-v3-fast": {
      "inputUsdPerMillion": 0.7999999999999999,
      "outputUsdPerMillion": 1.2,
      "provider": "morph"
    },
    "morph/morph-v3-large": {
      "inputUsdPerMillion": 0.8999999999999999,
      "outputUsdPerMillion": 1.9,
      "provider": "morph"
    },
    "nscale/Qwen/QwQ-32B": {
      "inputUsdPerMillion": 0.18,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "nscale",
      "sourceUrl": "https://docs.nscale.com/docs/inference/serverless-models/current#chat-models"
    },
    "nscale/Qwen/Qwen2.5-Coder-32B-Instruct": {
      "inputUsdPerMillion": 0.06,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "nscale",
      "sourceUrl": "https://docs.nscale.com/docs/inference/serverless-models/current#chat-models"
    },
    "nscale/Qwen/Qwen2.5-Coder-3B-Instruct": {
      "inputUsdPerMillion": 0.01,
      "outputUsdPerMillion": 0.03,
      "provider": "nscale",
      "sourceUrl": "https://docs.nscale.com/docs/inference/serverless-models/current#chat-models"
    },
    "nscale/Qwen/Qwen2.5-Coder-7B-Instruct": {
      "inputUsdPerMillion": 0.01,
      "outputUsdPerMillion": 0.03,
      "provider": "nscale",
      "sourceUrl": "https://docs.nscale.com/docs/inference/serverless-models/current#chat-models"
    },
    "nscale/deepseek-ai/DeepSeek-R1-Distill-Llama-70B": {
      "inputUsdPerMillion": 0.375,
      "outputUsdPerMillion": 0.375,
      "provider": "nscale",
      "sourceUrl": "https://docs.nscale.com/docs/inference/serverless-models/current#chat-models"
    },
    "nscale/deepseek-ai/DeepSeek-R1-Distill-Llama-8B": {
      "inputUsdPerMillion": 0.024999999999999998,
      "outputUsdPerMillion": 0.024999999999999998,
      "provider": "nscale",
      "sourceUrl": "https://docs.nscale.com/docs/inference/serverless-models/current#chat-models"
    },
    "nscale/deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B": {
      "inputUsdPerMillion": 0.09,
      "outputUsdPerMillion": 0.09,
      "provider": "nscale",
      "sourceUrl": "https://docs.nscale.com/docs/inference/serverless-models/current#chat-models"
    },
    "nscale/deepseek-ai/DeepSeek-R1-Distill-Qwen-14B": {
      "inputUsdPerMillion": 0.07,
      "outputUsdPerMillion": 0.07,
      "provider": "nscale",
      "sourceUrl": "https://docs.nscale.com/docs/inference/serverless-models/current#chat-models"
    },
    "nscale/deepseek-ai/DeepSeek-R1-Distill-Qwen-32B": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.15,
      "provider": "nscale",
      "sourceUrl": "https://docs.nscale.com/docs/inference/serverless-models/current#chat-models"
    },
    "nscale/deepseek-ai/DeepSeek-R1-Distill-Qwen-7B": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "nscale",
      "sourceUrl": "https://docs.nscale.com/docs/inference/serverless-models/current#chat-models"
    },
    "nscale/meta-llama/Llama-3.1-8B-Instruct": {
      "inputUsdPerMillion": 0.03,
      "outputUsdPerMillion": 0.03,
      "provider": "nscale",
      "sourceUrl": "https://docs.nscale.com/docs/inference/serverless-models/current#chat-models"
    },
    "nscale/meta-llama/Llama-3.3-70B-Instruct": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "nscale",
      "sourceUrl": "https://docs.nscale.com/docs/inference/serverless-models/current#chat-models"
    },
    "nscale/meta-llama/Llama-4-Scout-17B-16E-Instruct": {
      "inputUsdPerMillion": 0.09,
      "outputUsdPerMillion": 0.29,
      "provider": "nscale",
      "sourceUrl": "https://docs.nscale.com/docs/inference/serverless-models/current#chat-models"
    },
    "nscale/mistralai/mixtral-8x22b-instruct-v0.1": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 0.6,
      "provider": "nscale",
      "sourceUrl": "https://docs.nscale.com/docs/inference/serverless-models/current#chat-models"
    },
    "nebius/deepseek-ai/DeepSeek-R1": {
      "inputUsdPerMillion": 0.7999999999999999,
      "outputUsdPerMillion": 2.4,
      "provider": "nebius",
      "sourceUrl": "https://nebius.com/prices"
    },
    "nebius/deepseek-ai/DeepSeek-R1-0528": {
      "inputUsdPerMillion": 0.7999999999999999,
      "outputUsdPerMillion": 2.4,
      "provider": "nebius",
      "sourceUrl": "https://nebius.com/prices"
    },
    "nebius/deepseek-ai/DeepSeek-R1-Distill-Llama-70B": {
      "inputUsdPerMillion": 0.25,
      "outputUsdPerMillion": 0.75,
      "provider": "nebius",
      "sourceUrl": "https://nebius.com/prices"
    },
    "nebius/deepseek-ai/DeepSeek-V3": {
      "inputUsdPerMillion": 0.5,
      "outputUsdPerMillion": 1.5,
      "provider": "nebius",
      "sourceUrl": "https://nebius.com/prices"
    },
    "nebius/deepseek-ai/DeepSeek-V3-0324": {
      "inputUsdPerMillion": 0.5,
      "outputUsdPerMillion": 1.5,
      "provider": "nebius",
      "sourceUrl": "https://nebius.com/prices"
    },
    "nebius/google/gemma-3-27b-it": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.3,
      "provider": "nebius",
      "sourceUrl": "https://tokenfactory.nebius.com/models/catalog/text2text/google%2Fgemma-3-27b-it"
    },
    "nebius/meta-llama/Llama-3.3-70B-Instruct": {
      "inputUsdPerMillion": 0.13,
      "outputUsdPerMillion": 0.39999999999999997,
      "provider": "nebius",
      "sourceUrl": "https://nebius.com/prices"
    },
    "nebius/meta-llama/Llama-Guard-3-8B": {
      "inputUsdPerMillion": 0.02,
      "outputUsdPerMillion": 0.06,
      "provider": "nebius",
      "sourceUrl": "https://nebius.com/prices"
    },
    "nebius/meta-llama/Meta-Llama-3.1-8B-Instruct": {
      "inputUsdPerMillion": 0.02,
      "outputUsdPerMillion": 0.06,
      "provider": "nebius",
      "sourceUrl": "https://nebius.com/prices"
    },
    "nebius/meta-llama/Meta-Llama-3.1-70B-Instruct": {
      "inputUsdPerMillion": 0.13,
      "outputUsdPerMillion": 0.39999999999999997,
      "provider": "nebius",
      "sourceUrl": "https://nebius.com/prices"
    },
    "nebius/meta-llama/Meta-Llama-3.1-405B-Instruct": {
      "inputUsdPerMillion": 1,
      "outputUsdPerMillion": 3,
      "provider": "nebius",
      "sourceUrl": "https://nebius.com/prices"
    },
    "nebius/mistralai/Mistral-Nemo-Instruct-2407": {
      "inputUsdPerMillion": 0.04,
      "outputUsdPerMillion": 0.12,
      "provider": "nebius",
      "sourceUrl": "https://nebius.com/prices"
    },
    "nebius/NousResearch/Hermes-3-Llama-3.1-405B": {
      "inputUsdPerMillion": 1,
      "outputUsdPerMillion": 3,
      "provider": "nebius",
      "sourceUrl": "https://nebius.com/prices"
    },
    "nebius/nvidia/Llama-3.1-Nemotron-Ultra-253B-v1": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 1.7999999999999998,
      "provider": "nebius",
      "sourceUrl": "https://nebius.com/prices"
    },
    "nebius/nvidia/Llama-3.3-Nemotron-Super-49B-v1": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.39999999999999997,
      "provider": "nebius",
      "sourceUrl": "https://nebius.com/prices"
    },
    "nebius/Qwen/Qwen3-235B-A22B": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.6,
      "provider": "nebius",
      "sourceUrl": "https://nebius.com/prices"
    },
    "nebius/Qwen/Qwen3-32B": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.3,
      "provider": "nebius",
      "sourceUrl": "https://tokenfactory.nebius.com/models/catalog/text2text/Qwen%2FQwen3-32B"
    },
    "nebius/Qwen/Qwen3-30B-A3B": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.3,
      "provider": "nebius",
      "sourceUrl": "https://nebius.com/prices"
    },
    "nebius/Qwen/Qwen3-14B": {
      "inputUsdPerMillion": 0.08,
      "outputUsdPerMillion": 0.24,
      "provider": "nebius",
      "sourceUrl": "https://nebius.com/prices"
    },
    "nebius/Qwen/Qwen3-4B": {
      "inputUsdPerMillion": 0.08,
      "outputUsdPerMillion": 0.24,
      "provider": "nebius",
      "sourceUrl": "https://nebius.com/prices"
    },
    "nebius/Qwen/QwQ-32B": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.44999999999999996,
      "provider": "nebius",
      "sourceUrl": "https://nebius.com/prices"
    },
    "nebius/Qwen/Qwen2.5-72B-Instruct": {
      "inputUsdPerMillion": 0.13,
      "outputUsdPerMillion": 0.39999999999999997,
      "provider": "nebius",
      "sourceUrl": "https://nebius.com/prices"
    },
    "nebius/Qwen/Qwen2.5-32B-Instruct": {
      "inputUsdPerMillion": 0.06,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "nebius",
      "sourceUrl": "https://nebius.com/prices"
    },
    "nebius/Qwen/Qwen2.5-Coder-7B": {
      "inputUsdPerMillion": 0.01,
      "outputUsdPerMillion": 0.03,
      "provider": "nebius",
      "sourceUrl": "https://nebius.com/prices"
    },
    "nebius/Qwen/Qwen2.5-VL-72B-Instruct": {
      "inputUsdPerMillion": 0.25,
      "outputUsdPerMillion": 0.75,
      "provider": "nebius",
      "sourceUrl": "https://tokenfactory.nebius.com/models/catalog/image2text/Qwen%2FQwen2.5-VL-72B-Instruct"
    },
    "nebius/Qwen/Qwen2-VL-72B-Instruct": {
      "inputUsdPerMillion": 0.13,
      "outputUsdPerMillion": 0.39999999999999997,
      "provider": "nebius",
      "sourceUrl": "https://nebius.com/prices"
    },
    "nebius/Qwen/Qwen2-VL-7B-Instruct": {
      "inputUsdPerMillion": 0.02,
      "outputUsdPerMillion": 0.06,
      "provider": "nebius",
      "sourceUrl": "https://nebius.com/prices"
    },
    "nebius/deepseek-ai/DeepSeek-V4-Flash": {
      "inputUsdPerMillion": 0.14,
      "outputUsdPerMillion": 0.28,
      "provider": "nebius",
      "sourceUrl": "https://tokenfactory.nebius.com/models/catalog/text2text/deepseek-ai%2FDeepSeek-V4-Flash"
    },
    "nebius/deepseek-ai/DeepSeek-V4-Flash-0731": {
      "inputUsdPerMillion": 0.14,
      "outputUsdPerMillion": 0.28,
      "provider": "nebius",
      "sourceUrl": "https://tokenfactory.nebius.com/models/catalog/text2text/deepseek-ai%2FDeepSeek-V4-Flash-0731"
    },
    "nebius/deepseek-ai/DeepSeek-V4-Pro": {
      "inputUsdPerMillion": 1.75,
      "outputUsdPerMillion": 3.5,
      "provider": "nebius",
      "sourceUrl": "https://tokenfactory.nebius.com/models/catalog/text2text/deepseek-ai%2FDeepSeek-V4-Pro"
    },
    "nebius/deepseek-ai/DeepSeek-V4-Pro-0813": {
      "inputUsdPerMillion": 1.32,
      "outputUsdPerMillion": 3.9600000000000004,
      "provider": "nebius",
      "sourceUrl": "https://tokenfactory.nebius.com/models/catalog/text2text/deepseek-ai%2FDeepSeek-V4-Pro-0813"
    },
    "nebius/deepseek-ai/DeepSeek-V4.1-Flash": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 1.2,
      "provider": "nebius",
      "sourceUrl": "https://tokenfactory.nebius.com/endpoints?modals=endpoint-details&model-id=deepseek-ai/DeepSeek-V4.1-Flash"
    },
    "nebius/MiniMaxAI/MiniMax-M2.5": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 1.2,
      "provider": "nebius",
      "sourceUrl": "https://tokenfactory.nebius.com/models/catalog/text2text/MiniMaxAI%2FMiniMax-M2.5"
    },
    "nebius/MiniMaxAI/MiniMax-M3": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 1.2,
      "provider": "nebius",
      "sourceUrl": "https://tokenfactory.nebius.com/models/catalog/text2text/MiniMaxAI%2FMiniMax-M3"
    },
    "nebius/moonshotai/Kimi-K2.6": {
      "inputUsdPerMillion": 0.95,
      "outputUsdPerMillion": 4,
      "provider": "nebius",
      "sourceUrl": "https://tokenfactory.nebius.com/models/catalog/image2text/moonshotai%2FKimi-K2.6"
    },
    "nebius/moonshotai/Kimi-K2.7-Code": {
      "inputUsdPerMillion": 0.95,
      "outputUsdPerMillion": 4,
      "provider": "nebius",
      "sourceUrl": "https://tokenfactory.nebius.com/models/catalog/text2text/moonshotai%2FKimi-K2.7-Code"
    },
    "nebius/moonshotai/Kimi-K3": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 15,
      "provider": "nebius",
      "sourceUrl": "https://tokenfactory.nebius.com/models/catalog/image2text/moonshotai%2FKimi-K3"
    },
    "nebius/NousResearch/Hermes-4-405B": {
      "inputUsdPerMillion": 1,
      "outputUsdPerMillion": 3,
      "provider": "nebius",
      "sourceUrl": "https://tokenfactory.nebius.com/models/catalog/text2text/NousResearch%2FHermes-4-405B"
    },
    "nebius/NousResearch/Hermes-4-70B": {
      "inputUsdPerMillion": 0.13,
      "outputUsdPerMillion": 0.39999999999999997,
      "provider": "nebius",
      "sourceUrl": "https://tokenfactory.nebius.com/models/catalog/text2text/NousResearch%2FHermes-4-70B"
    },
    "nebius/nvidia/Cosmos3-Super-Reasoner": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.3,
      "provider": "nebius",
      "sourceUrl": "https://tokenfactory.nebius.com/models/catalog/image2text/nvidia%2FCosmos3-Super-Reasoner"
    },
    "nebius/nvidia/Llama-3_1-Nemotron-Ultra-253B-v1": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 1.7999999999999998,
      "provider": "nebius",
      "sourceUrl": "https://tokenfactory.nebius.com/models/catalog/text2text/nvidia%2FLlama-3_1-Nemotron-Ultra-253B-v1"
    },
    "nebius/nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B": {
      "inputUsdPerMillion": 0.06,
      "outputUsdPerMillion": 0.24,
      "provider": "nebius",
      "sourceUrl": "https://tokenfactory.nebius.com/models/catalog/text2text/nvidia%2FNVIDIA-Nemotron-3-Nano-30B-A3B"
    },
    "nebius/nvidia/Nemotron-3-Nano-Omni": {
      "inputUsdPerMillion": 0.06,
      "outputUsdPerMillion": 0.24,
      "provider": "nebius",
      "sourceUrl": "https://tokenfactory.nebius.com/models/catalog/text2text/nvidia%2FNemotron-3-Nano-Omni"
    },
    "nebius/nvidia/nemotron-3-super-120b-a12b": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 0.8999999999999999,
      "provider": "nebius",
      "sourceUrl": "https://tokenfactory.nebius.com/models/catalog/text2text/nvidia%2Fnemotron-3-super-120b-a12b"
    },
    "nebius/nvidia/Nemotron-3-Ultra-550b-a55b": {
      "inputUsdPerMillion": 1,
      "outputUsdPerMillion": 3,
      "provider": "nebius",
      "sourceUrl": "https://tokenfactory.nebius.com/models/catalog/text2text/nvidia%2FNemotron-3-Ultra-550b-a55b"
    },
    "nebius/nvidia/Nemotron-3_5-Lightning": {
      "inputUsdPerMillion": 0.06,
      "outputUsdPerMillion": 0.24,
      "provider": "nebius",
      "sourceUrl": "https://tokenfactory.nebius.com/models/catalog/text2text/nvidia%2FNemotron-3_5-Lightning"
    },
    "nebius/openai/gpt-oss-120b": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.6,
      "provider": "nebius",
      "sourceUrl": "https://tokenfactory.nebius.com/models/catalog/text2text/openai%2Fgpt-oss-120b"
    },
    "nebius/openbmb/MiniCPM-V-4_5": {
      "inputUsdPerMillion": 0.658,
      "outputUsdPerMillion": 1.1099999999999999,
      "provider": "nebius",
      "sourceUrl": "https://tokenfactory.nebius.com/models/catalog/image2text/openbmb%2FMiniCPM-V-4_5"
    },
    "nebius/Qwen/Qwen3-235B-A22B-Instruct-2507": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.6,
      "provider": "nebius",
      "sourceUrl": "https://tokenfactory.nebius.com/models/catalog/text2text/Qwen%2FQwen3-235B-A22B-Instruct-2507"
    },
    "nebius/Qwen/Qwen3-30B-A3B-Instruct-2507": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.3,
      "provider": "nebius",
      "sourceUrl": "https://tokenfactory.nebius.com/models/catalog/text2text/Qwen%2FQwen3-30B-A3B-Instruct-2507"
    },
    "nebius/Qwen/Qwen3-Next-80B-A3B-Thinking": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 1.2,
      "provider": "nebius",
      "sourceUrl": "https://tokenfactory.nebius.com/models/catalog/text2text/Qwen%2FQwen3-Next-80B-A3B-Thinking"
    },
    "nebius/Qwen/Qwen3.5-397B-A17B": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 3.5999999999999996,
      "provider": "nebius",
      "sourceUrl": "https://tokenfactory.nebius.com/models/catalog/text2text/Qwen%2FQwen3.5-397B-A17B"
    },
    "nebius/Qwen/Qwen3.8-27B": {
      "inputUsdPerMillion": 0.44999999999999996,
      "outputUsdPerMillion": 3,
      "provider": "nebius",
      "sourceUrl": "https://tokenfactory.nebius.com/models/catalog/text2text/Qwen%2FQwen3.8-27B"
    },
    "nebius/zai-org/GLM-5.1": {
      "inputUsdPerMillion": 1.4,
      "outputUsdPerMillion": 4.4,
      "provider": "nebius",
      "sourceUrl": "https://tokenfactory.nebius.com/models/catalog/text2text/zai-org%2FGLM-5.1"
    },
    "nebius/zai-org/GLM-5.2": {
      "inputUsdPerMillion": 1.4,
      "outputUsdPerMillion": 4.4,
      "provider": "nebius",
      "sourceUrl": "https://tokenfactory.nebius.com/models/catalog/text2text/zai-org%2FGLM-5.2"
    },
    "nebius/zai-org/GLM-5.3": {
      "inputUsdPerMillion": 1.4,
      "outputUsdPerMillion": 4.4,
      "provider": "nebius",
      "sourceUrl": "https://tokenfactory.nebius.com/models/catalog/text2text/zai-org%2FGLM-5.3"
    },
    "nebius/zai-org/GLM-5.3-Flash": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.5,
      "provider": "nebius",
      "sourceUrl": "https://tokenfactory.nebius.com/models/catalog/text2text/zai-org%2FGLM-5.3-Flash"
    },
    "nvidia.nemotron-nano-12b-v2": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.6,
      "provider": "bedrock_converse",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-nvidia-nvidia-nemotron-nano-12b-v2-vl-bf16.html"
    },
    "nvidia.nemotron-nano-9b-v2": {
      "inputUsdPerMillion": 0.06,
      "outputUsdPerMillion": 0.22999999999999998,
      "provider": "bedrock_converse",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-nvidia-nvidia-nemotron-nano-9b-v2.html"
    },
    "nvidia.nemotron-nano-3-30b": {
      "inputUsdPerMillion": 0.06,
      "outputUsdPerMillion": 0.24,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "nvidia.nemotron-super-3-120b": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.65,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "o1": {
      "inputUsdPerMillion": 15,
      "outputUsdPerMillion": 60,
      "cacheReadUsdPerMillion": 7.5,
      "provider": "openai",
      "sourceUrl": "https://developers.openai.com/api/docs/pricing"
    },
    "o1-2024-12-17": {
      "inputUsdPerMillion": 15,
      "outputUsdPerMillion": 60,
      "cacheReadUsdPerMillion": 7.5,
      "provider": "openai",
      "sourceUrl": "https://developers.openai.com/api/docs/pricing"
    },
    "o3": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 8,
      "cacheReadUsdPerMillion": 0.5,
      "provider": "openai",
      "sourceUrl": "https://developers.openai.com/api/docs/pricing"
    },
    "o3-2025-04-16": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 8,
      "cacheReadUsdPerMillion": 0.5,
      "provider": "openai",
      "sourceUrl": "https://developers.openai.com/api/docs/pricing"
    },
    "o3-mini": {
      "inputUsdPerMillion": 1.1,
      "outputUsdPerMillion": 4.4,
      "cacheReadUsdPerMillion": 0.55,
      "provider": "openai",
      "sourceUrl": "https://developers.openai.com/api/docs/pricing"
    },
    "o3-mini-2025-01-31": {
      "inputUsdPerMillion": 1.1,
      "outputUsdPerMillion": 4.4,
      "cacheReadUsdPerMillion": 0.55,
      "provider": "openai",
      "sourceUrl": "https://developers.openai.com/api/docs/pricing"
    },
    "o4-mini": {
      "inputUsdPerMillion": 1.1,
      "outputUsdPerMillion": 4.4,
      "cacheReadUsdPerMillion": 0.275,
      "provider": "openai",
      "sourceUrl": "https://developers.openai.com/api/docs/pricing"
    },
    "o4-mini-2025-04-16": {
      "inputUsdPerMillion": 1.1,
      "outputUsdPerMillion": 4.4,
      "cacheReadUsdPerMillion": 0.275,
      "provider": "openai",
      "sourceUrl": "https://developers.openai.com/api/docs/pricing"
    },
    "oci/meta.llama-3.1-8b-instruct": {
      "inputUsdPerMillion": 0.72,
      "outputUsdPerMillion": 0.72,
      "provider": "oci",
      "sourceUrl": "https://www.oracle.com/artificial-intelligence/generative-ai/generative-ai-service/pricing"
    },
    "oci/meta.llama-3.1-70b-instruct": {
      "inputUsdPerMillion": 0.72,
      "outputUsdPerMillion": 0.72,
      "provider": "oci",
      "sourceUrl": "https://www.oracle.com/artificial-intelligence/generative-ai/generative-ai-service/pricing"
    },
    "oci/meta.llama-3.1-405b-instruct": {
      "inputUsdPerMillion": 10.68,
      "outputUsdPerMillion": 10.68,
      "provider": "oci",
      "sourceUrl": "https://www.oracle.com/artificial-intelligence/generative-ai/generative-ai-service/pricing"
    },
    "oci/meta.llama-3.2-90b-vision-instruct": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 2,
      "provider": "oci",
      "sourceUrl": "https://www.oracle.com/artificial-intelligence/generative-ai/generative-ai-service/pricing"
    },
    "oci/meta.llama-3.3-70b-instruct": {
      "inputUsdPerMillion": 0.72,
      "outputUsdPerMillion": 0.72,
      "provider": "oci",
      "sourceUrl": "https://www.oracle.com/artificial-intelligence/generative-ai/generative-ai-service/pricing"
    },
    "oci/meta.llama-4-maverick-17b-128e-instruct-fp8": {
      "inputUsdPerMillion": 0.72,
      "outputUsdPerMillion": 0.72,
      "provider": "oci",
      "sourceUrl": "https://www.oracle.com/artificial-intelligence/generative-ai/generative-ai-service/pricing"
    },
    "oci/meta.llama-4-scout-17b-16e-instruct": {
      "inputUsdPerMillion": 0.72,
      "outputUsdPerMillion": 0.72,
      "provider": "oci",
      "sourceUrl": "https://www.oracle.com/artificial-intelligence/generative-ai/generative-ai-service/pricing"
    },
    "oci/xai.grok-3": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 15,
      "provider": "oci",
      "sourceUrl": "https://www.oracle.com/artificial-intelligence/generative-ai/generative-ai-service/pricing"
    },
    "oci/xai.grok-3-fast": {
      "inputUsdPerMillion": 5,
      "outputUsdPerMillion": 25,
      "provider": "oci",
      "sourceUrl": "https://www.oracle.com/artificial-intelligence/generative-ai/generative-ai-service/pricing"
    },
    "oci/xai.grok-3-mini": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 0.5,
      "provider": "oci",
      "sourceUrl": "https://www.oracle.com/artificial-intelligence/generative-ai/generative-ai-service/pricing"
    },
    "oci/xai.grok-3-mini-fast": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 4,
      "provider": "oci",
      "sourceUrl": "https://www.oracle.com/artificial-intelligence/generative-ai/generative-ai-service/pricing"
    },
    "oci/xai.grok-4": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 15,
      "provider": "oci",
      "sourceUrl": "https://www.oracle.com/artificial-intelligence/generative-ai/generative-ai-service/pricing"
    },
    "oci/cohere.command-latest": {
      "inputUsdPerMillion": 1.56,
      "outputUsdPerMillion": 1.56,
      "provider": "oci",
      "sourceUrl": "https://www.oracle.com/artificial-intelligence/enterprise-ai/cost-estimator/"
    },
    "oci/cohere.command-a-03-2025": {
      "inputUsdPerMillion": 1.56,
      "outputUsdPerMillion": 1.56,
      "provider": "oci",
      "sourceUrl": "https://www.oracle.com/artificial-intelligence/enterprise-ai/cost-estimator/"
    },
    "oci/cohere.command-plus-latest": {
      "inputUsdPerMillion": 1.56,
      "outputUsdPerMillion": 1.56,
      "provider": "oci",
      "sourceUrl": "https://www.oracle.com/artificial-intelligence/enterprise-ai/cost-estimator/"
    },
    "oci/google.gemini-2.5-flash": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.6,
      "provider": "oci",
      "sourceUrl": "https://www.oracle.com/artificial-intelligence/generative-ai/generative-ai-service/pricing"
    },
    "oci/google.gemini-2.5-pro": {
      "inputUsdPerMillion": 1.25,
      "outputUsdPerMillion": 10,
      "provider": "oci",
      "sourceUrl": "https://www.oracle.com/artificial-intelligence/generative-ai/generative-ai-service/pricing"
    },
    "oci/google.gemini-2.5-flash-lite": {
      "inputUsdPerMillion": 0.075,
      "outputUsdPerMillion": 0.3,
      "provider": "oci",
      "sourceUrl": "https://www.oracle.com/artificial-intelligence/generative-ai/generative-ai-service/pricing"
    },
    "oci/cohere.command-a-vision": {
      "inputUsdPerMillion": 1.56,
      "outputUsdPerMillion": 1.56,
      "provider": "oci",
      "sourceUrl": "https://www.oracle.com/artificial-intelligence/enterprise-ai/cost-estimator/"
    },
    "oci/cohere.command-a-reasoning": {
      "inputUsdPerMillion": 1.56,
      "outputUsdPerMillion": 1.56,
      "provider": "oci",
      "sourceUrl": "https://www.oracle.com/artificial-intelligence/enterprise-ai/cost-estimator/"
    },
    "oci/cohere.command-a-reasoning-08-2025": {
      "inputUsdPerMillion": 1.56,
      "outputUsdPerMillion": 1.56,
      "provider": "oci",
      "sourceUrl": "https://www.oracle.com/artificial-intelligence/generative-ai/generative-ai-service/pricing"
    },
    "oci/cohere.command-a-vision-07-2025": {
      "inputUsdPerMillion": 1.56,
      "outputUsdPerMillion": 1.56,
      "provider": "oci",
      "sourceUrl": "https://www.oracle.com/artificial-intelligence/generative-ai/generative-ai-service/pricing"
    },
    "oci/cohere.command-a-translate-08-2025": {
      "inputUsdPerMillion": 0.09,
      "outputUsdPerMillion": 0.09,
      "provider": "oci",
      "sourceUrl": "https://www.oracle.com/artificial-intelligence/generative-ai/generative-ai-service/pricing"
    },
    "oci/cohere.command-r-08-2024": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.15,
      "provider": "oci",
      "sourceUrl": "https://www.oracle.com/artificial-intelligence/generative-ai/generative-ai-service/pricing"
    },
    "oci/cohere.command-r-plus-08-2024": {
      "inputUsdPerMillion": 1.56,
      "outputUsdPerMillion": 1.56,
      "provider": "oci",
      "sourceUrl": "https://www.oracle.com/artificial-intelligence/generative-ai/generative-ai-service/pricing"
    },
    "oci/meta.llama-3.2-11b-vision-instruct": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 2,
      "provider": "oci",
      "sourceUrl": "https://www.oracle.com/artificial-intelligence/generative-ai/generative-ai-service/pricing"
    },
    "oci/meta.llama-3.3-70b-instruct-fp8-dynamic": {
      "inputUsdPerMillion": 0.72,
      "outputUsdPerMillion": 0.72,
      "provider": "oci",
      "sourceUrl": "https://www.oracle.com/artificial-intelligence/generative-ai/generative-ai-service/pricing"
    },
    "oci/xai.grok-4-fast": {
      "inputUsdPerMillion": 5,
      "outputUsdPerMillion": 25,
      "provider": "oci",
      "sourceUrl": "https://www.oracle.com/artificial-intelligence/generative-ai/generative-ai-service/pricing"
    },
    "oci/xai.grok-4.1-fast": {
      "inputUsdPerMillion": 5,
      "outputUsdPerMillion": 25,
      "provider": "oci",
      "sourceUrl": "https://www.oracle.com/artificial-intelligence/generative-ai/generative-ai-service/pricing"
    },
    "oci/xai.grok-4.20": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 15,
      "provider": "oci",
      "sourceUrl": "https://www.oracle.com/artificial-intelligence/generative-ai/generative-ai-service/pricing"
    },
    "oci/xai.grok-4.20-multi-agent": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 15,
      "provider": "oci",
      "sourceUrl": "https://www.oracle.com/artificial-intelligence/generative-ai/generative-ai-service/pricing"
    },
    "oci/xai.grok-code-fast-1": {
      "inputUsdPerMillion": 5,
      "outputUsdPerMillion": 25,
      "provider": "oci",
      "sourceUrl": "https://www.oracle.com/artificial-intelligence/generative-ai/generative-ai-service/pricing"
    },
    "oci/openai.gpt-5": {
      "inputUsdPerMillion": 1.25,
      "outputUsdPerMillion": 10,
      "provider": "oci",
      "sourceUrl": "https://www.oracle.com/artificial-intelligence/generative-ai/generative-ai-service/pricing"
    },
    "oci/openai.gpt-5-mini": {
      "inputUsdPerMillion": 0.25,
      "outputUsdPerMillion": 2,
      "provider": "oci",
      "sourceUrl": "https://www.oracle.com/artificial-intelligence/generative-ai/generative-ai-service/pricing"
    },
    "oci/openai.gpt-5-nano": {
      "inputUsdPerMillion": 0.049999999999999996,
      "outputUsdPerMillion": 0.39999999999999997,
      "provider": "oci",
      "sourceUrl": "https://www.oracle.com/artificial-intelligence/generative-ai/generative-ai-service/pricing"
    },
    "ollama/codegeex4": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "ollama"
    },
    "ollama/codegemma": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "ollama"
    },
    "ollama/codellama": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "ollama"
    },
    "ollama/deepseek-coder-v2-base": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "ollama"
    },
    "ollama/deepseek-coder-v2-instruct": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "ollama"
    },
    "ollama/deepseek-coder-v2-lite-base": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "ollama"
    },
    "ollama/deepseek-coder-v2-lite-instruct": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "ollama"
    },
    "ollama/deepseek-v3.1:671b-cloud": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "ollama"
    },
    "ollama/gpt-oss:120b-cloud": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "ollama"
    },
    "ollama/gpt-oss:20b-cloud": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "ollama"
    },
    "ollama/internlm2_5-20b-chat": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "ollama"
    },
    "ollama/llama2": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "ollama"
    },
    "ollama/llama2-uncensored": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "ollama"
    },
    "ollama/llama2:13b": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "ollama"
    },
    "ollama/llama2:70b": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "ollama"
    },
    "ollama/llama2:7b": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "ollama"
    },
    "ollama/llama3": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "ollama"
    },
    "ollama/llama3.1": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "ollama"
    },
    "ollama/llama3:70b": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "ollama"
    },
    "ollama/llama3:8b": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "ollama"
    },
    "ollama/mistral": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "ollama"
    },
    "ollama/mistral-7B-Instruct-v0.1": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "ollama"
    },
    "ollama/mistral-7B-Instruct-v0.2": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "ollama"
    },
    "ollama/mistral-large-instruct-2407": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "ollama"
    },
    "ollama/mixtral-8x22B-Instruct-v0.1": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "ollama"
    },
    "ollama/mixtral-8x7B-Instruct-v0.1": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "ollama"
    },
    "ollama/orca-mini": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "ollama"
    },
    "ollama/qwen3-coder:480b-cloud": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "ollama"
    },
    "ollama/vicuna": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "ollama"
    },
    "openai.gpt-oss-120b-1:0": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.6,
      "provider": "bedrock_converse",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-oss-120b.html"
    },
    "openai.gpt-oss-20b-1:0": {
      "inputUsdPerMillion": 0.07,
      "outputUsdPerMillion": 0.3,
      "provider": "bedrock_converse",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-oss-20b.html"
    },
    "openai.gpt-oss-safeguard-120b": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.6,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "openai.gpt-oss-safeguard-20b": {
      "inputUsdPerMillion": 0.07,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "ovhcloud/DeepSeek-R1-Distill-Llama-70B": {
      "inputUsdPerMillion": 0.67,
      "outputUsdPerMillion": 0.67,
      "provider": "ovhcloud",
      "sourceUrl": "https://www.ovhcloud.com/en/public-cloud/ai-endpoints/catalog/"
    },
    "ovhcloud/Llama-3.1-8B-Instruct": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.09999999999999999,
      "provider": "ovhcloud",
      "sourceUrl": "https://www.ovhcloud.com/en/public-cloud/ai-endpoints/catalog/"
    },
    "ovhcloud/Meta-Llama-3_1-70B-Instruct": {
      "inputUsdPerMillion": 0.67,
      "outputUsdPerMillion": 0.67,
      "provider": "ovhcloud",
      "sourceUrl": "https://www.ovhcloud.com/en/public-cloud/ai-endpoints/catalog/"
    },
    "ovhcloud/Meta-Llama-3_3-70B-Instruct": {
      "inputUsdPerMillion": 0.67,
      "outputUsdPerMillion": 0.67,
      "provider": "ovhcloud",
      "sourceUrl": "https://www.ovhcloud.com/en/public-cloud/ai-endpoints/catalog/"
    },
    "ovhcloud/Mistral-7B-Instruct-v0.3": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.09999999999999999,
      "provider": "ovhcloud",
      "sourceUrl": "https://www.ovhcloud.com/en/public-cloud/ai-endpoints/catalog/"
    },
    "ovhcloud/Mistral-Nemo-Instruct-2407": {
      "inputUsdPerMillion": 0.13,
      "outputUsdPerMillion": 0.13,
      "provider": "ovhcloud",
      "sourceUrl": "https://www.ovhcloud.com/en/public-cloud/ai-endpoints/catalog/"
    },
    "ovhcloud/Mistral-Small-3.2-24B-Instruct-2506": {
      "inputUsdPerMillion": 0.09,
      "outputUsdPerMillion": 0.28,
      "provider": "ovhcloud",
      "sourceUrl": "https://www.ovhcloud.com/en/public-cloud/ai-endpoints/catalog/"
    },
    "ovhcloud/Mixtral-8x7B-Instruct-v0.1": {
      "inputUsdPerMillion": 0.63,
      "outputUsdPerMillion": 0.63,
      "provider": "ovhcloud",
      "sourceUrl": "https://www.ovhcloud.com/en/public-cloud/ai-endpoints/catalog/"
    },
    "ovhcloud/Qwen2.5-Coder-32B-Instruct": {
      "inputUsdPerMillion": 0.87,
      "outputUsdPerMillion": 0.87,
      "provider": "ovhcloud",
      "sourceUrl": "https://www.ovhcloud.com/en/public-cloud/ai-endpoints/catalog/"
    },
    "ovhcloud/Qwen2.5-VL-72B-Instruct": {
      "inputUsdPerMillion": 0.9099999999999999,
      "outputUsdPerMillion": 0.9099999999999999,
      "provider": "ovhcloud",
      "sourceUrl": "https://www.ovhcloud.com/en/public-cloud/ai-endpoints/catalog/"
    },
    "ovhcloud/Qwen3-32B": {
      "inputUsdPerMillion": 0.08,
      "outputUsdPerMillion": 0.22999999999999998,
      "provider": "ovhcloud",
      "sourceUrl": "https://www.ovhcloud.com/en/public-cloud/ai-endpoints/catalog/"
    },
    "ovhcloud/gpt-oss-120b": {
      "inputUsdPerMillion": 0.08,
      "outputUsdPerMillion": 0.39999999999999997,
      "provider": "ovhcloud",
      "sourceUrl": "https://www.ovhcloud.com/en/public-cloud/ai-endpoints/catalog/"
    },
    "ovhcloud/gpt-oss-20b": {
      "inputUsdPerMillion": 0.04,
      "outputUsdPerMillion": 0.15,
      "provider": "ovhcloud",
      "sourceUrl": "https://www.ovhcloud.com/en/public-cloud/ai-endpoints/catalog/"
    },
    "ovhcloud/llava-v1.6-mistral-7b-hf": {
      "inputUsdPerMillion": 0.29,
      "outputUsdPerMillion": 0.29,
      "provider": "ovhcloud",
      "sourceUrl": "https://www.ovhcloud.com/en/public-cloud/ai-endpoints/catalog/"
    },
    "ovhcloud/mamba-codestral-7B-v0.1": {
      "inputUsdPerMillion": 0.19,
      "outputUsdPerMillion": 0.19,
      "provider": "ovhcloud",
      "sourceUrl": "https://www.ovhcloud.com/en/public-cloud/ai-endpoints/catalog/"
    },
    "perplexity/codellama-34b-instruct": {
      "inputUsdPerMillion": 0.35,
      "outputUsdPerMillion": 1.4,
      "provider": "perplexity"
    },
    "perplexity/codellama-70b-instruct": {
      "inputUsdPerMillion": 0.7,
      "outputUsdPerMillion": 2.8,
      "provider": "perplexity"
    },
    "perplexity/llama-2-70b-chat": {
      "inputUsdPerMillion": 0.7,
      "outputUsdPerMillion": 2.8,
      "provider": "perplexity"
    },
    "perplexity/llama-3.1-70b-instruct": {
      "inputUsdPerMillion": 1,
      "outputUsdPerMillion": 1,
      "provider": "perplexity"
    },
    "perplexity/llama-3.1-8b-instruct": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "perplexity"
    },
    "perplexity/mistral-7b-instruct": {
      "inputUsdPerMillion": 0.07,
      "outputUsdPerMillion": 0.28,
      "provider": "perplexity"
    },
    "perplexity/mixtral-8x7b-instruct": {
      "inputUsdPerMillion": 0.07,
      "outputUsdPerMillion": 0.28,
      "provider": "perplexity"
    },
    "perplexity/pplx-70b-chat": {
      "inputUsdPerMillion": 0.7,
      "outputUsdPerMillion": 2.8,
      "provider": "perplexity"
    },
    "perplexity/pplx-70b-online": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 2.8,
      "provider": "perplexity"
    },
    "perplexity/pplx-7b-chat": {
      "inputUsdPerMillion": 0.07,
      "outputUsdPerMillion": 0.28,
      "provider": "perplexity"
    },
    "perplexity/pplx-7b-online": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0.28,
      "provider": "perplexity"
    },
    "perplexity/sonar": {
      "inputUsdPerMillion": 1,
      "outputUsdPerMillion": 1,
      "provider": "perplexity"
    },
    "perplexity/sonar-deep-research": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 8,
      "reasoningUsdPerMillion": 3,
      "provider": "perplexity"
    },
    "perplexity/sonar-medium-chat": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 1.7999999999999998,
      "provider": "perplexity"
    },
    "perplexity/sonar-medium-online": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 1.7999999999999998,
      "provider": "perplexity"
    },
    "perplexity/sonar-pro": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 15,
      "provider": "perplexity"
    },
    "perplexity/sonar-reasoning": {
      "inputUsdPerMillion": 1,
      "outputUsdPerMillion": 5,
      "provider": "perplexity"
    },
    "perplexity/sonar-reasoning-pro": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 8,
      "provider": "perplexity"
    },
    "perplexity/sonar-small-chat": {
      "inputUsdPerMillion": 0.07,
      "outputUsdPerMillion": 0.28,
      "provider": "perplexity"
    },
    "perplexity/sonar-small-online": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0.28,
      "provider": "perplexity"
    },
    "publicai/swiss-ai/apertus-8b-instruct": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "publicai",
      "sourceUrl": "https://platform.publicai.co/docs"
    },
    "publicai/swiss-ai/apertus-70b-instruct": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "publicai",
      "sourceUrl": "https://platform.publicai.co/docs"
    },
    "publicai/aisingapore/Gemma-SEA-LION-v4-27B-IT": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "publicai",
      "sourceUrl": "https://platform.publicai.co/docs"
    },
    "publicai/BSC-LT/salamandra-7b-instruct-tools-16k": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "publicai",
      "sourceUrl": "https://platform.publicai.co/docs"
    },
    "publicai/BSC-LT/ALIA-40b-instruct_Q8_0": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "publicai",
      "sourceUrl": "https://platform.publicai.co/docs"
    },
    "publicai/allenai/Olmo-3-7B-Instruct": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "publicai",
      "sourceUrl": "https://platform.publicai.co/docs"
    },
    "publicai/aisingapore/Qwen-SEA-LION-v4-32B-IT": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "publicai",
      "sourceUrl": "https://platform.publicai.co/docs"
    },
    "publicai/allenai/Olmo-3-7B-Think": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "publicai",
      "sourceUrl": "https://platform.publicai.co/docs"
    },
    "publicai/allenai/Olmo-3-32B-Think": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "publicai",
      "sourceUrl": "https://platform.publicai.co/docs"
    },
    "qwen.qwen3-coder-480b-a35b-v1:0": {
      "inputUsdPerMillion": 0.44999999999999996,
      "outputUsdPerMillion": 1.7999999999999998,
      "provider": "bedrock_converse",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-qwen-qwen3-coder-480b-a35b-instruct.html"
    },
    "qwen.qwen3-235b-a22b-2507-v1:0": {
      "inputUsdPerMillion": 0.22,
      "outputUsdPerMillion": 0.88,
      "provider": "bedrock_converse",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-qwen-qwen3-235b-a22b-2507.html"
    },
    "qwen.qwen3-coder-30b-a3b-v1:0": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.6,
      "provider": "bedrock_converse",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-qwen-qwen3-coder-30b-a3b-instruct.html"
    },
    "qwen.qwen3-32b-v1:0": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.6,
      "provider": "bedrock_converse",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-qwen-qwen3-32b.html"
    },
    "qwen.qwen3-next-80b-a3b": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 1.2,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "bedrock/ap-northeast-1/qwen.qwen3-next-80b-a3b": {
      "inputUsdPerMillion": 0.18,
      "outputUsdPerMillion": 1.4500000000000002,
      "provider": "bedrock",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-qwen-qwen3-next-80b-a3b.html"
    },
    "bedrock/ap-south-1/qwen.qwen3-next-80b-a3b": {
      "inputUsdPerMillion": 0.18,
      "outputUsdPerMillion": 1.4100000000000001,
      "provider": "bedrock",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-qwen-qwen3-next-80b-a3b.html"
    },
    "bedrock/ap-southeast-2/qwen.qwen3-next-80b-a3b": {
      "inputUsdPerMillion": 0.1545,
      "outputUsdPerMillion": 1.236,
      "provider": "bedrock",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-qwen-qwen3-next-80b-a3b.html"
    },
    "bedrock/eu-west-1/qwen.qwen3-next-80b-a3b": {
      "inputUsdPerMillion": 0.18,
      "outputUsdPerMillion": 1.4100000000000001,
      "provider": "bedrock",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-qwen-qwen3-next-80b-a3b.html"
    },
    "bedrock/eu-west-2/qwen.qwen3-next-80b-a3b": {
      "inputUsdPerMillion": 0.22999999999999998,
      "outputUsdPerMillion": 1.8599999999999999,
      "provider": "bedrock",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-qwen-qwen3-next-80b-a3b.html"
    },
    "bedrock/sa-east-1/qwen.qwen3-next-80b-a3b": {
      "inputUsdPerMillion": 0.18,
      "outputUsdPerMillion": 1.4500000000000002,
      "provider": "bedrock",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-qwen-qwen3-next-80b-a3b.html"
    },
    "qwen.qwen3-vl-235b-a22b": {
      "inputUsdPerMillion": 0.53,
      "outputUsdPerMillion": 2.66,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "qwen.qwen3-coder-next": {
      "inputUsdPerMillion": 0.5,
      "outputUsdPerMillion": 1.2,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "replicate/meta/llama-2-13b": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.5,
      "provider": "replicate"
    },
    "replicate/meta/llama-2-13b-chat": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.5,
      "provider": "replicate"
    },
    "replicate/meta/llama-2-70b": {
      "inputUsdPerMillion": 0.65,
      "outputUsdPerMillion": 2.75,
      "provider": "replicate"
    },
    "replicate/meta/llama-2-70b-chat": {
      "inputUsdPerMillion": 0.65,
      "outputUsdPerMillion": 2.75,
      "provider": "replicate"
    },
    "replicate/meta/llama-2-7b": {
      "inputUsdPerMillion": 0.049999999999999996,
      "outputUsdPerMillion": 0.25,
      "provider": "replicate"
    },
    "replicate/meta/llama-2-7b-chat": {
      "inputUsdPerMillion": 0.049999999999999996,
      "outputUsdPerMillion": 0.25,
      "provider": "replicate"
    },
    "replicate/meta/llama-3-70b": {
      "inputUsdPerMillion": 0.65,
      "outputUsdPerMillion": 2.75,
      "provider": "replicate"
    },
    "replicate/meta/llama-3-70b-instruct": {
      "inputUsdPerMillion": 0.65,
      "outputUsdPerMillion": 2.75,
      "provider": "replicate"
    },
    "replicate/meta/llama-3-8b": {
      "inputUsdPerMillion": 0.049999999999999996,
      "outputUsdPerMillion": 0.25,
      "provider": "replicate"
    },
    "replicate/meta/llama-3-8b-instruct": {
      "inputUsdPerMillion": 0.049999999999999996,
      "outputUsdPerMillion": 0.25,
      "provider": "replicate"
    },
    "replicate/mistralai/mistral-7b-instruct-v0.2": {
      "inputUsdPerMillion": 0.049999999999999996,
      "outputUsdPerMillion": 0.25,
      "provider": "replicate"
    },
    "replicate/mistralai/mistral-7b-v0.1": {
      "inputUsdPerMillion": 0.049999999999999996,
      "outputUsdPerMillion": 0.25,
      "provider": "replicate"
    },
    "replicate/mistralai/mixtral-8x7b-instruct-v0.1": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 1,
      "provider": "replicate"
    },
    "replicate/openai/gpt-5": {
      "inputUsdPerMillion": 1.25,
      "outputUsdPerMillion": 10,
      "provider": "replicate"
    },
    "replicate/openai/gpt-oss-20b": {
      "inputUsdPerMillion": 0.09,
      "outputUsdPerMillion": 0.36,
      "provider": "replicate"
    },
    "replicate/anthropic/claude-4.5-haiku": {
      "inputUsdPerMillion": 1,
      "outputUsdPerMillion": 5,
      "provider": "replicate"
    },
    "replicate/ibm-granite/granite-3.3-8b-instruct": {
      "inputUsdPerMillion": 0.03,
      "outputUsdPerMillion": 0.25,
      "provider": "replicate"
    },
    "replicate/openai/gpt-4o": {
      "inputUsdPerMillion": 2.5,
      "outputUsdPerMillion": 10,
      "provider": "replicate"
    },
    "replicate/openai/o4-mini": {
      "inputUsdPerMillion": 1,
      "outputUsdPerMillion": 4,
      "reasoningUsdPerMillion": 4,
      "provider": "replicate"
    },
    "replicate/openai/o1-mini": {
      "inputUsdPerMillion": 1.1,
      "outputUsdPerMillion": 4.4,
      "reasoningUsdPerMillion": 4.4,
      "provider": "replicate"
    },
    "replicate/openai/o1": {
      "inputUsdPerMillion": 15,
      "outputUsdPerMillion": 60,
      "reasoningUsdPerMillion": 60,
      "provider": "replicate"
    },
    "replicate/openai/gpt-4o-mini": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.6,
      "provider": "replicate"
    },
    "replicate/qwen/qwen3-235b-a22b-instruct-2507": {
      "inputUsdPerMillion": 0.26399999999999996,
      "outputUsdPerMillion": 1.06,
      "provider": "replicate"
    },
    "replicate/anthropic/claude-4-sonnet": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 15,
      "provider": "replicate"
    },
    "replicate/deepseek-ai/deepseek-v3": {
      "inputUsdPerMillion": 1.4500000000000002,
      "outputUsdPerMillion": 1.4500000000000002,
      "provider": "replicate"
    },
    "replicate/anthropic/claude-3.7-sonnet": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 15,
      "provider": "replicate"
    },
    "replicate/anthropic/claude-3.5-haiku": {
      "inputUsdPerMillion": 1,
      "outputUsdPerMillion": 5,
      "provider": "replicate"
    },
    "replicate/anthropic/claude-3.5-sonnet": {
      "inputUsdPerMillion": 3.75,
      "outputUsdPerMillion": 18.75,
      "provider": "replicate"
    },
    "replicate/google/gemini-3-pro": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 12,
      "provider": "replicate"
    },
    "replicate/anthropic/claude-4.5-sonnet": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 15,
      "provider": "replicate"
    },
    "replicate/openai/gpt-4.1": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 8,
      "provider": "replicate"
    },
    "replicate/openai/gpt-4.1-nano": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.39999999999999997,
      "provider": "replicate"
    },
    "replicate/openai/gpt-4.1-mini": {
      "inputUsdPerMillion": 0.39999999999999997,
      "outputUsdPerMillion": 1.5999999999999999,
      "provider": "replicate"
    },
    "replicate/openai/gpt-5-nano": {
      "inputUsdPerMillion": 0.049999999999999996,
      "outputUsdPerMillion": 0.39999999999999997,
      "provider": "replicate"
    },
    "replicate/openai/gpt-5-mini": {
      "inputUsdPerMillion": 0.25,
      "outputUsdPerMillion": 2,
      "provider": "replicate"
    },
    "replicate/google/gemini-2.5-flash": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 2.5,
      "provider": "replicate"
    },
    "replicate/openai/gpt-oss-120b": {
      "inputUsdPerMillion": 0.18,
      "outputUsdPerMillion": 0.72,
      "provider": "replicate"
    },
    "replicate/deepseek-ai/deepseek-v3.1": {
      "inputUsdPerMillion": 0.6719999999999999,
      "outputUsdPerMillion": 2.016,
      "provider": "replicate"
    },
    "replicate/xai/grok-4": {
      "inputUsdPerMillion": 7.199999999999999,
      "outputUsdPerMillion": 36,
      "provider": "replicate"
    },
    "replicate/deepseek-ai/deepseek-r1": {
      "inputUsdPerMillion": 3.75,
      "outputUsdPerMillion": 10,
      "reasoningUsdPerMillion": 10,
      "provider": "replicate"
    },
    "sagemaker/meta-textgeneration-llama-2-13b": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "sagemaker"
    },
    "sagemaker/meta-textgeneration-llama-2-13b-f": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "sagemaker"
    },
    "sagemaker/meta-textgeneration-llama-2-70b": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "sagemaker"
    },
    "sagemaker/meta-textgeneration-llama-2-70b-b-f": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "sagemaker"
    },
    "sagemaker/meta-textgeneration-llama-2-7b": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "sagemaker"
    },
    "sagemaker/meta-textgeneration-llama-2-7b-f": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "sagemaker"
    },
    "sambanova/MiniMax-M2.7": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 2.4,
      "provider": "sambanova",
      "sourceUrl": "https://cloud.sambanova.ai/plans/pricing"
    },
    "sambanova/DeepSeek-R1": {
      "inputUsdPerMillion": 5,
      "outputUsdPerMillion": 7,
      "provider": "sambanova",
      "sourceUrl": "https://cloud.sambanova.ai/plans/pricing"
    },
    "sambanova/Llama-4-Maverick-17B-128E-Instruct": {
      "inputUsdPerMillion": 0.63,
      "outputUsdPerMillion": 1.7999999999999998,
      "provider": "sambanova",
      "sourceUrl": "https://cloud.sambanova.ai/plans/pricing"
    },
    "sambanova/Meta-Llama-3.3-70B-Instruct": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 1.2,
      "provider": "sambanova",
      "sourceUrl": "https://cloud.sambanova.ai/plans/pricing"
    },
    "sambanova/DeepSeek-V3.1": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 4.5,
      "provider": "sambanova",
      "sourceUrl": "https://cloud.sambanova.ai/plans/pricing"
    },
    "sambanova/gpt-oss-120b": {
      "inputUsdPerMillion": 0.22,
      "outputUsdPerMillion": 0.59,
      "provider": "sambanova",
      "sourceUrl": "https://cloud.sambanova.ai/plans/pricing"
    },
    "sambanova/DeepSeek-V3.2": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 4.5,
      "provider": "sambanova",
      "sourceUrl": "https://cloud.sambanova.ai/plans/pricing"
    },
    "sambanova/gemma-4-31B-it": {
      "inputUsdPerMillion": 0.38,
      "outputUsdPerMillion": 1.15,
      "provider": "sambanova",
      "sourceUrl": "https://cloud.sambanova.ai/plans/pricing"
    },
    "scx-ai/GLM-5.2": {
      "inputUsdPerMillion": 0.61,
      "outputUsdPerMillion": 1.9800000000000002,
      "cacheReadUsdPerMillion": 0.22,
      "provider": "scx-ai",
      "sourceUrl": "https://scx.ai/pricing"
    },
    "scx-ai/Qwen3.8-Max": {
      "inputUsdPerMillion": 1.6500000000000001,
      "outputUsdPerMillion": 4.989999999999999,
      "cacheReadUsdPerMillion": 0.21,
      "provider": "scx-ai",
      "sourceUrl": "https://scx.ai/pricing"
    },
    "snowflake/claude-3-5-sonnet": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 15,
      "cacheReadUsdPerMillion": 0.3,
      "provider": "snowflake"
    },
    "snowflake/deepseek-r1": {
      "inputUsdPerMillion": 1.35,
      "outputUsdPerMillion": 5.4,
      "provider": "snowflake"
    },
    "snowflake/llama3.1-405b": {
      "inputUsdPerMillion": 1.2,
      "outputUsdPerMillion": 1.2,
      "provider": "snowflake"
    },
    "snowflake/llama3.1-70b": {
      "inputUsdPerMillion": 0.72,
      "outputUsdPerMillion": 0.72,
      "provider": "snowflake"
    },
    "snowflake/llama3.1-8b": {
      "inputUsdPerMillion": 0.24,
      "outputUsdPerMillion": 0.24,
      "provider": "snowflake"
    },
    "snowflake/llama3.3-70b": {
      "inputUsdPerMillion": 0.72,
      "outputUsdPerMillion": 0.72,
      "provider": "snowflake"
    },
    "snowflake/mistral-large2": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 6,
      "provider": "snowflake"
    },
    "snowflake/snowflake-llama-3.3-70b": {
      "inputUsdPerMillion": 0.72,
      "outputUsdPerMillion": 0.72,
      "provider": "snowflake"
    },
    "text-completion-codestral/codestral-2405": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "text-completion-codestral",
      "sourceUrl": "https://docs.mistral.ai/capabilities/code_generation/"
    },
    "text-completion-codestral/codestral-latest": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "text-completion-codestral",
      "sourceUrl": "https://docs.mistral.ai/capabilities/code_generation/"
    },
    "text-unicorn": {
      "inputUsdPerMillion": 10,
      "outputUsdPerMillion": 28,
      "provider": "vertex_ai-text-models",
      "sourceUrl": "https://cloud.google.com/vertex-ai/generative-ai/docs/learn/models#foundation_models"
    },
    "text-unicorn@001": {
      "inputUsdPerMillion": 10,
      "outputUsdPerMillion": 28,
      "provider": "vertex_ai-text-models",
      "sourceUrl": "https://cloud.google.com/vertex-ai/generative-ai/docs/learn/models#foundation_models"
    },
    "together-ai-21.1b-41b": {
      "inputUsdPerMillion": 0.7999999999999999,
      "outputUsdPerMillion": 0.7999999999999999,
      "provider": "together_ai"
    },
    "together-ai-4.1b-8b": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "together_ai"
    },
    "together-ai-41.1b-80b": {
      "inputUsdPerMillion": 0.8999999999999999,
      "outputUsdPerMillion": 0.8999999999999999,
      "provider": "together_ai"
    },
    "together-ai-8.1b-21b": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 0.3,
      "provider": "together_ai"
    },
    "together-ai-81.1b-110b": {
      "inputUsdPerMillion": 1.7999999999999998,
      "outputUsdPerMillion": 1.7999999999999998,
      "provider": "together_ai"
    },
    "together-ai-up-to-4b": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.09999999999999999,
      "provider": "together_ai"
    },
    "together_ai/Qwen/Qwen2.5-7B-Instruct-Turbo": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 0.3,
      "provider": "together_ai",
      "sourceUrl": "https://api.together.ai/v1/models"
    },
    "together_ai/deepseek-ai/DeepSeek-V3": {
      "inputUsdPerMillion": 1.25,
      "outputUsdPerMillion": 1.25,
      "provider": "together_ai"
    },
    "together_ai/meta-llama/Llama-3.3-70B-Instruct-Turbo": {
      "inputUsdPerMillion": 1.04,
      "outputUsdPerMillion": 1.04,
      "provider": "together_ai",
      "sourceUrl": "https://api.together.ai/v1/models"
    },
    "together_ai/moonshotai/Kimi-K2-Instruct": {
      "inputUsdPerMillion": 1,
      "outputUsdPerMillion": 3,
      "provider": "together_ai",
      "sourceUrl": "https://www.together.ai/models/kimi-k2-instruct"
    },
    "together_ai/openai/gpt-oss-120b": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.6,
      "provider": "together_ai",
      "sourceUrl": "https://api.together.ai/v1/models"
    },
    "together_ai/zai-org/GLM-4.6": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 2.2,
      "provider": "together_ai",
      "sourceUrl": "https://api.together.ai/v1/models"
    },
    "together_ai/MiniMaxAI/MiniMax-M3": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 1.2,
      "cacheReadUsdPerMillion": 0.06,
      "provider": "together_ai",
      "sourceUrl": "https://api.together.ai/v1/models"
    },
    "together_ai/Prism-ML/Ternary-Bonsai-27B": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "together_ai",
      "sourceUrl": "https://docs.together.ai/docs/serverless-models"
    },
    "together_ai/Qwen/Qwen3.5-9B": {
      "inputUsdPerMillion": 0.16999999999999998,
      "outputUsdPerMillion": 0.25,
      "provider": "together_ai",
      "sourceUrl": "https://api.together.ai/v1/models"
    },
    "together_ai/Qwen/Qwen3.6-Plus": {
      "inputUsdPerMillion": 0.5,
      "outputUsdPerMillion": 3,
      "provider": "together_ai",
      "sourceUrl": "https://api.together.ai/v1/models"
    },
    "together_ai/Qwen/Qwen3.7-Max": {
      "inputUsdPerMillion": 2.5,
      "outputUsdPerMillion": 7.5,
      "cacheReadUsdPerMillion": 0.5,
      "provider": "together_ai",
      "sourceUrl": "https://api.together.ai/v1/models"
    },
    "together_ai/Qwen/Qwen3.7-Plus": {
      "inputUsdPerMillion": 0.32,
      "outputUsdPerMillion": 1.28,
      "provider": "together_ai",
      "sourceUrl": "https://api.together.ai/v1/models"
    },
    "together_ai/Qwen/Qwen3.8-2.4T-A95B": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 6,
      "cacheReadUsdPerMillion": 0.25,
      "provider": "together_ai",
      "sourceUrl": "https://api.together.ai/v1/models"
    },
    "together_ai/arize-ai/qwen-2-1.5b-instruct": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.09999999999999999,
      "provider": "together_ai",
      "sourceUrl": "https://api.together.ai/v1/models"
    },
    "together_ai/deepseek-ai/DeepSeek-V4-Flash-0731": {
      "inputUsdPerMillion": 0.14,
      "outputUsdPerMillion": 0.28,
      "cacheReadUsdPerMillion": 0.03,
      "provider": "together_ai",
      "sourceUrl": "https://api.together.ai/v1/models"
    },
    "together_ai/deepseek-ai/DeepSeek-V4.1-Flash": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 1.2,
      "cacheReadUsdPerMillion": 0.006,
      "provider": "together_ai",
      "sourceUrl": "https://api.together.ai/v1/models"
    },
    "together_ai/deepseek-ai/DeepSeek-V4-Pro-0813": {
      "inputUsdPerMillion": 1.32,
      "outputUsdPerMillion": 3.9600000000000004,
      "cacheReadUsdPerMillion": 0.13,
      "provider": "together_ai",
      "sourceUrl": "https://api.together.ai/v1/models"
    },
    "together_ai/meta-models/Muse-Glimmer-30B": {
      "inputUsdPerMillion": 0.35,
      "outputUsdPerMillion": 1.5,
      "cacheReadUsdPerMillion": 0.04,
      "provider": "together_ai",
      "sourceUrl": "https://api.together.ai/v1/models"
    },
    "together_ai/moonshotai/Kimi-K3": {
      "inputUsdPerMillion": 2.7,
      "outputUsdPerMillion": 13.5,
      "cacheReadUsdPerMillion": 0.27,
      "provider": "together_ai",
      "sourceUrl": "https://api.together.ai/v1/models"
    },
    "together_ai/thinkingmachines/Inkling": {
      "inputUsdPerMillion": 1,
      "outputUsdPerMillion": 4.05,
      "cacheReadUsdPerMillion": 0.16999999999999998,
      "provider": "together_ai",
      "sourceUrl": "https://api.together.ai/v1/models"
    },
    "together_ai/zai-org/GLM-5.2": {
      "inputUsdPerMillion": 1.4,
      "outputUsdPerMillion": 4.4,
      "cacheReadUsdPerMillion": 0.26,
      "provider": "together_ai",
      "sourceUrl": "https://api.together.ai/v1/models"
    },
    "together_ai/zai-org/GLM-5.3": {
      "inputUsdPerMillion": 1.4,
      "outputUsdPerMillion": 4.4,
      "cacheReadUsdPerMillion": 0.26,
      "provider": "together_ai",
      "sourceUrl": "https://api.together.ai/v1/models"
    },
    "together_ai/zai-org/GLM-5.3-Flash": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.5,
      "cacheReadUsdPerMillion": 0.03,
      "provider": "together_ai",
      "sourceUrl": "https://api.together.ai/v1/models"
    },
    "us.amazon.nova-lite-v1:0": {
      "inputUsdPerMillion": 0.06,
      "outputUsdPerMillion": 0.24,
      "cacheReadUsdPerMillion": 0.015,
      "provider": "bedrock_converse"
    },
    "us.amazon.nova-micro-v1:0": {
      "inputUsdPerMillion": 0.035,
      "outputUsdPerMillion": 0.14,
      "cacheReadUsdPerMillion": 0.00875,
      "provider": "bedrock_converse"
    },
    "us.amazon.nova-pro-v1:0": {
      "inputUsdPerMillion": 0.7999999999999999,
      "outputUsdPerMillion": 3.1999999999999997,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "provider": "bedrock_converse"
    },
    "us.anthropic.claude-3-5-haiku-20241022-v1:0": {
      "inputUsdPerMillion": 0.7999999999999999,
      "outputUsdPerMillion": 4,
      "cacheReadUsdPerMillion": 0.08,
      "cacheWriteUsdPerMillion": 1,
      "provider": "bedrock"
    },
    "us.anthropic.claude-haiku-4-5-20251001-v1:0": {
      "inputUsdPerMillion": 1.1,
      "outputUsdPerMillion": 5.5,
      "cacheReadUsdPerMillion": 0.11,
      "cacheWriteUsdPerMillion": 1.375,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "us.anthropic.claude-3-5-sonnet-20240620-v1:0": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 15,
      "cacheReadUsdPerMillion": 0.3,
      "cacheWriteUsdPerMillion": 3.75,
      "provider": "bedrock"
    },
    "us.anthropic.claude-3-5-sonnet-20241022-v2:0": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 15,
      "cacheReadUsdPerMillion": 0.3,
      "cacheWriteUsdPerMillion": 3.75,
      "provider": "bedrock"
    },
    "us.anthropic.claude-3-7-sonnet-20250219-v1:0": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 15,
      "cacheReadUsdPerMillion": 0.3,
      "cacheWriteUsdPerMillion": 3.75,
      "provider": "bedrock_converse"
    },
    "us.anthropic.claude-3-opus-20240229-v1:0": {
      "inputUsdPerMillion": 15,
      "outputUsdPerMillion": 75,
      "cacheReadUsdPerMillion": 1.5,
      "cacheWriteUsdPerMillion": 18.75,
      "provider": "bedrock"
    },
    "us.anthropic.claude-opus-4-1-20250805-v1:0": {
      "inputUsdPerMillion": 15,
      "outputUsdPerMillion": 75,
      "cacheReadUsdPerMillion": 1.5,
      "cacheWriteUsdPerMillion": 18.75,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "us.anthropic.claude-sonnet-4-5-20250929-v1:0": {
      "inputUsdPerMillion": 3.3000000000000003,
      "outputUsdPerMillion": 16.5,
      "cacheReadUsdPerMillion": 0.33,
      "cacheWriteUsdPerMillion": 4.125,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "us-gov.anthropic.claude-sonnet-4-5-20250929-v1:0": {
      "inputUsdPerMillion": 3.5999999999999996,
      "outputUsdPerMillion": 18,
      "cacheReadUsdPerMillion": 0.36,
      "cacheWriteUsdPerMillion": 4.5,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "us-gov.anthropic.claude-sonnet-5": {
      "inputUsdPerMillion": 2.4,
      "outputUsdPerMillion": 12,
      "cacheReadUsdPerMillion": 0.24,
      "cacheWriteUsdPerMillion": 3,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "us-gov.anthropic.claude-opus-4-8": {
      "inputUsdPerMillion": 6,
      "outputUsdPerMillion": 30,
      "cacheReadUsdPerMillion": 0.6,
      "cacheWriteUsdPerMillion": 7.5,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "us-gov.anthropic.claude-opus-5": {
      "inputUsdPerMillion": 6,
      "outputUsdPerMillion": 30,
      "cacheReadUsdPerMillion": 0.6,
      "cacheWriteUsdPerMillion": 7.5,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "us-gov.anthropic.claude-opus-5-5": {
      "inputUsdPerMillion": 4.8,
      "outputUsdPerMillion": 24,
      "cacheReadUsdPerMillion": 0.24,
      "cacheWriteUsdPerMillion": 6,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "us-gov.anthropic.claude-fable-5-1": {
      "inputUsdPerMillion": 12,
      "outputUsdPerMillion": 60,
      "cacheReadUsdPerMillion": 0.3,
      "cacheWriteUsdPerMillion": 15,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "us-gov.nvidia.nemotron-nano-3-30b": {
      "inputUsdPerMillion": 0.072,
      "outputUsdPerMillion": 0.288,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "us-gov.nvidia.nemotron-nano-12b-v2": {
      "inputUsdPerMillion": 0.24,
      "outputUsdPerMillion": 0.72,
      "provider": "bedrock_converse",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-nvidia-nvidia-nemotron-nano-12b-v2-vl-bf16.html"
    },
    "us-gov.nvidia.nemotron-nano-9b-v2": {
      "inputUsdPerMillion": 0.072,
      "outputUsdPerMillion": 0.27599999999999997,
      "provider": "bedrock_converse",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-nvidia-nvidia-nemotron-nano-9b-v2.html"
    },
    "us-gov.nvidia.nemotron-super-3-120b": {
      "inputUsdPerMillion": 0.18,
      "outputUsdPerMillion": 0.78,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "us-gov.openai.gpt-oss-20b-1:0": {
      "inputUsdPerMillion": 0.08399999999999999,
      "outputUsdPerMillion": 0.36,
      "provider": "bedrock_converse",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-oss-20b.html"
    },
    "us-gov.openai.gpt-oss-120b-1:0": {
      "inputUsdPerMillion": 0.18,
      "outputUsdPerMillion": 0.72,
      "provider": "bedrock_converse",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-oss-120b.html"
    },
    "us-gov.xai.grok-4.6": {
      "inputUsdPerMillion": 2.64,
      "outputUsdPerMillion": 7.920000000000001,
      "cacheReadUsdPerMillion": 0.66,
      "provider": "bedrock_converse"
    },
    "au.anthropic.claude-haiku-4-5-20251001-v1:0": {
      "inputUsdPerMillion": 1.1,
      "outputUsdPerMillion": 5.5,
      "cacheReadUsdPerMillion": 0.11,
      "cacheWriteUsdPerMillion": 1.375,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "us.anthropic.claude-opus-4-20250514-v1:0": {
      "inputUsdPerMillion": 15,
      "outputUsdPerMillion": 75,
      "cacheReadUsdPerMillion": 1.5,
      "cacheWriteUsdPerMillion": 18.75,
      "provider": "bedrock_converse"
    },
    "us.anthropic.claude-opus-4-5-20251101-v1:0": {
      "inputUsdPerMillion": 5.5,
      "outputUsdPerMillion": 27.5,
      "cacheReadUsdPerMillion": 0.55,
      "cacheWriteUsdPerMillion": 6.875,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "global.anthropic.claude-opus-4-5-20251101-v1:0": {
      "inputUsdPerMillion": 5,
      "outputUsdPerMillion": 25,
      "cacheReadUsdPerMillion": 0.5,
      "cacheWriteUsdPerMillion": 6.25,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "eu.anthropic.claude-opus-4-5-20251101-v1:0": {
      "inputUsdPerMillion": 5.5,
      "outputUsdPerMillion": 27.5,
      "cacheReadUsdPerMillion": 0.55,
      "cacheWriteUsdPerMillion": 6.875,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "us.anthropic.claude-sonnet-4-20250514-v1:0": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 15,
      "cacheReadUsdPerMillion": 0.3,
      "cacheWriteUsdPerMillion": 3.75,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "us.deepseek.r1-v1:0": {
      "inputUsdPerMillion": 1.35,
      "outputUsdPerMillion": 5.4,
      "provider": "bedrock_converse",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-deepseek-deepseek-r1.html"
    },
    "us.deepseek.v3.2": {
      "inputUsdPerMillion": 0.62,
      "outputUsdPerMillion": 1.85,
      "provider": "bedrock_converse"
    },
    "eu.deepseek.v3.2": {
      "inputUsdPerMillion": 0.74,
      "outputUsdPerMillion": 2.2199999999999998,
      "provider": "bedrock_converse"
    },
    "us.meta.llama3-1-405b-instruct-v1:0": {
      "inputUsdPerMillion": 2.4,
      "outputUsdPerMillion": 2.4,
      "provider": "bedrock",
      "sourceUrl": "https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/bedrock/USD/current/bedrock.json"
    },
    "us.meta.llama3-1-70b-instruct-v1:0": {
      "inputUsdPerMillion": 0.72,
      "outputUsdPerMillion": 0.72,
      "provider": "bedrock",
      "sourceUrl": "https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/bedrock/USD/current/bedrock.json"
    },
    "us.meta.llama3-1-8b-instruct-v1:0": {
      "inputUsdPerMillion": 0.22,
      "outputUsdPerMillion": 0.22,
      "provider": "bedrock"
    },
    "us.meta.llama3-2-11b-instruct-v1:0": {
      "inputUsdPerMillion": 0.16,
      "outputUsdPerMillion": 0.16,
      "provider": "bedrock",
      "sourceUrl": "https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/bedrock/USD/current/bedrock.json"
    },
    "us.meta.llama3-2-1b-instruct-v1:0": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.09999999999999999,
      "provider": "bedrock"
    },
    "us.meta.llama3-2-3b-instruct-v1:0": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.15,
      "provider": "bedrock"
    },
    "us.meta.llama3-2-90b-instruct-v1:0": {
      "inputUsdPerMillion": 0.72,
      "outputUsdPerMillion": 0.72,
      "provider": "bedrock",
      "sourceUrl": "https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/bedrock/USD/current/bedrock.json"
    },
    "us.meta.llama3-3-70b-instruct-v1:0": {
      "inputUsdPerMillion": 0.72,
      "outputUsdPerMillion": 0.72,
      "provider": "bedrock_converse"
    },
    "us.meta.llama4-maverick-17b-instruct-v1:0": {
      "inputUsdPerMillion": 0.24,
      "outputUsdPerMillion": 0.9700000000000001,
      "provider": "bedrock_converse"
    },
    "us.meta.llama4-scout-17b-instruct-v1:0": {
      "inputUsdPerMillion": 0.16999999999999998,
      "outputUsdPerMillion": 0.66,
      "provider": "bedrock_converse"
    },
    "us.mistral.pixtral-large-2502-v1:0": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 6,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "v0/v0-1.0-md": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 15,
      "provider": "v0"
    },
    "v0/v0-1.5-lg": {
      "inputUsdPerMillion": 15,
      "outputUsdPerMillion": 75,
      "provider": "v0"
    },
    "v0/v0-1.5-md": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 15,
      "provider": "v0"
    },
    "vercel_ai_gateway/alibaba/qwen-3-14b": {
      "inputUsdPerMillion": 0.08,
      "outputUsdPerMillion": 0.24,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/alibaba/qwen-3-235b": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.6,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/alibaba/qwen-3-30b": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.3,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/alibaba/qwen-3-32b": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.3,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/alibaba/qwen3-coder": {
      "inputUsdPerMillion": 0.39999999999999997,
      "outputUsdPerMillion": 1.5999999999999999,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/amazon/nova-lite": {
      "inputUsdPerMillion": 0.06,
      "outputUsdPerMillion": 0.24,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/amazon/nova-micro": {
      "inputUsdPerMillion": 0.035,
      "outputUsdPerMillion": 0.14,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/amazon/nova-pro": {
      "inputUsdPerMillion": 0.7999999999999999,
      "outputUsdPerMillion": 3.1999999999999997,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/amazon/titan-embed-text-v2": {
      "inputUsdPerMillion": 0.02,
      "outputUsdPerMillion": 0,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/anthropic/claude-3-haiku": {
      "inputUsdPerMillion": 0.25,
      "outputUsdPerMillion": 1.25,
      "cacheReadUsdPerMillion": 0.03,
      "cacheWriteUsdPerMillion": 0.3,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/anthropic/claude-3-opus": {
      "inputUsdPerMillion": 15,
      "outputUsdPerMillion": 75,
      "cacheReadUsdPerMillion": 1.5,
      "cacheWriteUsdPerMillion": 18.75,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/anthropic/claude-3.5-haiku": {
      "inputUsdPerMillion": 0.7999999999999999,
      "outputUsdPerMillion": 4,
      "cacheReadUsdPerMillion": 0.08,
      "cacheWriteUsdPerMillion": 1,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/anthropic/claude-3.5-sonnet": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 15,
      "cacheReadUsdPerMillion": 0.3,
      "cacheWriteUsdPerMillion": 3.75,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/anthropic/claude-3.7-sonnet": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 15,
      "cacheReadUsdPerMillion": 0.3,
      "cacheWriteUsdPerMillion": 3.75,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/anthropic/claude-4-opus": {
      "inputUsdPerMillion": 15,
      "outputUsdPerMillion": 75,
      "cacheReadUsdPerMillion": 1.5,
      "cacheWriteUsdPerMillion": 18.75,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/anthropic/claude-4-sonnet": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 15,
      "cacheReadUsdPerMillion": 0.3,
      "cacheWriteUsdPerMillion": 3.75,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/anthropic/claude-3-5-sonnet": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 15,
      "cacheReadUsdPerMillion": 0.3,
      "cacheWriteUsdPerMillion": 3.75,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/anthropic/claude-3-5-sonnet-20241022": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 15,
      "cacheReadUsdPerMillion": 0.3,
      "cacheWriteUsdPerMillion": 3.75,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/anthropic/claude-3-7-sonnet": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 15,
      "cacheReadUsdPerMillion": 0.3,
      "cacheWriteUsdPerMillion": 3.75,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/anthropic/claude-haiku-4.5": {
      "inputUsdPerMillion": 1,
      "outputUsdPerMillion": 5,
      "cacheReadUsdPerMillion": 0.09999999999999999,
      "cacheWriteUsdPerMillion": 1.25,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/anthropic/claude-opus-4": {
      "inputUsdPerMillion": 15,
      "outputUsdPerMillion": 75,
      "cacheReadUsdPerMillion": 1.5,
      "cacheWriteUsdPerMillion": 18.75,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/anthropic/claude-opus-4.1": {
      "inputUsdPerMillion": 15,
      "outputUsdPerMillion": 75,
      "cacheReadUsdPerMillion": 1.5,
      "cacheWriteUsdPerMillion": 18.75,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/anthropic/claude-opus-4.5": {
      "inputUsdPerMillion": 5,
      "outputUsdPerMillion": 25,
      "cacheReadUsdPerMillion": 0.5,
      "cacheWriteUsdPerMillion": 6.25,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/anthropic/claude-opus-4.6": {
      "inputUsdPerMillion": 5,
      "outputUsdPerMillion": 25,
      "cacheReadUsdPerMillion": 0.5,
      "cacheWriteUsdPerMillion": 6.25,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/anthropic/claude-sonnet-4": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 15,
      "cacheReadUsdPerMillion": 0.3,
      "cacheWriteUsdPerMillion": 3.75,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/anthropic/claude-sonnet-4.5": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 15,
      "cacheReadUsdPerMillion": 0.3,
      "cacheWriteUsdPerMillion": 3.75,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/cohere/command-a": {
      "inputUsdPerMillion": 2.5,
      "outputUsdPerMillion": 10,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/cohere/command-r": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.6,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/cohere/command-r-plus": {
      "inputUsdPerMillion": 2.5,
      "outputUsdPerMillion": 10,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/cohere/embed-v4.0": {
      "inputUsdPerMillion": 0.12,
      "outputUsdPerMillion": 0,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/deepseek/deepseek-r1": {
      "inputUsdPerMillion": 0.55,
      "outputUsdPerMillion": 2.1900000000000004,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/deepseek/deepseek-r1-distill-llama-70b": {
      "inputUsdPerMillion": 0.75,
      "outputUsdPerMillion": 0.9900000000000001,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/deepseek/deepseek-v3": {
      "inputUsdPerMillion": 0.8999999999999999,
      "outputUsdPerMillion": 0.8999999999999999,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/google/gemini-2.5-flash": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 2.5,
      "cacheReadUsdPerMillion": 0.03,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/google/gemini-2.5-pro": {
      "inputUsdPerMillion": 1.25,
      "outputUsdPerMillion": 10,
      "cacheReadUsdPerMillion": 0.125,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/google/gemma-2-9b": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/inception/mercury-coder-small": {
      "inputUsdPerMillion": 0.25,
      "outputUsdPerMillion": 1,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/meta/llama-3-70b": {
      "inputUsdPerMillion": 0.59,
      "outputUsdPerMillion": 0.7899999999999999,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/meta/llama-3-8b": {
      "inputUsdPerMillion": 0.049999999999999996,
      "outputUsdPerMillion": 0.08,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/meta/llama-3.1-70b": {
      "inputUsdPerMillion": 0.72,
      "outputUsdPerMillion": 0.72,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/meta/llama-3.1-8b": {
      "inputUsdPerMillion": 0.049999999999999996,
      "outputUsdPerMillion": 0.08,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/meta/llama-3.2-11b": {
      "inputUsdPerMillion": 0.16,
      "outputUsdPerMillion": 0.16,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/meta/llama-3.2-1b": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.09999999999999999,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/meta/llama-3.2-3b": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.15,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/meta/llama-3.2-90b": {
      "inputUsdPerMillion": 0.72,
      "outputUsdPerMillion": 0.72,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/meta/llama-3.3-70b": {
      "inputUsdPerMillion": 0.72,
      "outputUsdPerMillion": 0.72,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/meta/llama-4-maverick": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.6,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/meta/llama-4-scout": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.3,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/mistral/codestral": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 0.8999999999999999,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/mistral/codestral-embed": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/mistral/devstral-small": {
      "inputUsdPerMillion": 0.07,
      "outputUsdPerMillion": 0.28,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/mistral/magistral-medium": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 5,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/mistral/magistral-small": {
      "inputUsdPerMillion": 0.5,
      "outputUsdPerMillion": 1.5,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/mistral/ministral-3b": {
      "inputUsdPerMillion": 0.04,
      "outputUsdPerMillion": 0.04,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/mistral/ministral-8b": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.09999999999999999,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/mistral/mistral-embed": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/mistral/mistral-large": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 6,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/mistral/mistral-saba-24b": {
      "inputUsdPerMillion": 0.7899999999999999,
      "outputUsdPerMillion": 0.7899999999999999,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/mistral/mistral-small": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.3,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/mistral/mixtral-8x22b-instruct": {
      "inputUsdPerMillion": 1.2,
      "outputUsdPerMillion": 1.2,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/mistral/pixtral-12b": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.15,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/mistral/pixtral-large": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 6,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/moonshotai/kimi-k2": {
      "inputUsdPerMillion": 0.55,
      "outputUsdPerMillion": 2.2,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/morph/morph-v3-fast": {
      "inputUsdPerMillion": 0.7999999999999999,
      "outputUsdPerMillion": 1.2,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/morph/morph-v3-large": {
      "inputUsdPerMillion": 0.8999999999999999,
      "outputUsdPerMillion": 1.9,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/openai/gpt-3.5-turbo": {
      "inputUsdPerMillion": 0.5,
      "outputUsdPerMillion": 1.5,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/openai/gpt-3.5-turbo-instruct": {
      "inputUsdPerMillion": 1.5,
      "outputUsdPerMillion": 2,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/openai/gpt-4-turbo": {
      "inputUsdPerMillion": 10,
      "outputUsdPerMillion": 30,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/openai/gpt-4.1": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 8,
      "cacheReadUsdPerMillion": 0.5,
      "cacheWriteUsdPerMillion": 0,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/openai/gpt-4.1-mini": {
      "inputUsdPerMillion": 0.39999999999999997,
      "outputUsdPerMillion": 1.5999999999999999,
      "cacheReadUsdPerMillion": 0.09999999999999999,
      "cacheWriteUsdPerMillion": 0,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/openai/gpt-4.1-nano": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.39999999999999997,
      "cacheReadUsdPerMillion": 0.024999999999999998,
      "cacheWriteUsdPerMillion": 0,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/openai/gpt-4o": {
      "inputUsdPerMillion": 2.5,
      "outputUsdPerMillion": 10,
      "cacheReadUsdPerMillion": 1.25,
      "cacheWriteUsdPerMillion": 0,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/openai/gpt-4o-mini": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.6,
      "cacheReadUsdPerMillion": 0.075,
      "cacheWriteUsdPerMillion": 0,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/openai/o1": {
      "inputUsdPerMillion": 15,
      "outputUsdPerMillion": 60,
      "cacheReadUsdPerMillion": 7.5,
      "cacheWriteUsdPerMillion": 0,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/openai/o3": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 8,
      "cacheReadUsdPerMillion": 0.5,
      "cacheWriteUsdPerMillion": 0,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/openai/o3-mini": {
      "inputUsdPerMillion": 1.1,
      "outputUsdPerMillion": 4.4,
      "cacheReadUsdPerMillion": 0.55,
      "cacheWriteUsdPerMillion": 0,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/openai/o4-mini": {
      "inputUsdPerMillion": 1.1,
      "outputUsdPerMillion": 4.4,
      "cacheReadUsdPerMillion": 0.275,
      "cacheWriteUsdPerMillion": 0,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/perplexity/sonar": {
      "inputUsdPerMillion": 1,
      "outputUsdPerMillion": 1,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/perplexity/sonar-pro": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 15,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/perplexity/sonar-reasoning": {
      "inputUsdPerMillion": 1,
      "outputUsdPerMillion": 5,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/perplexity/sonar-reasoning-pro": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 8,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/vercel/v0-1.0-md": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 15,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/vercel/v0-1.5-md": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 15,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/xai/grok-2": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 10,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/xai/grok-2-vision": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 10,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/xai/grok-3": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 15,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/xai/grok-3-fast": {
      "inputUsdPerMillion": 5,
      "outputUsdPerMillion": 25,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/xai/grok-3-mini": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 0.5,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/xai/grok-3-mini-fast": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 4,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/xai/grok-4": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 15,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/zai/glm-4.5": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 2.2,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/zai/glm-4.5-air": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 1.1,
      "provider": "vercel_ai_gateway"
    },
    "vercel_ai_gateway/zai/glm-4.6": {
      "inputUsdPerMillion": 0.44999999999999996,
      "outputUsdPerMillion": 1.7999999999999998,
      "cacheReadUsdPerMillion": 0.11,
      "provider": "vercel_ai_gateway",
      "sourceUrl": "https://vercel.com/ai-gateway/models/glm-4.6"
    },
    "vertex_ai/claude-3-5-haiku": {
      "inputUsdPerMillion": 1,
      "outputUsdPerMillion": 5,
      "provider": "vertex_ai-anthropic_models"
    },
    "vertex_ai/claude-3-5-haiku@20241022": {
      "inputUsdPerMillion": 1,
      "outputUsdPerMillion": 5,
      "provider": "vertex_ai-anthropic_models"
    },
    "vertex_ai/claude-haiku-4-5": {
      "inputUsdPerMillion": 1,
      "outputUsdPerMillion": 5,
      "cacheReadUsdPerMillion": 0.09999999999999999,
      "cacheWriteUsdPerMillion": 1.25,
      "provider": "vertex_ai-anthropic_models",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "vertex_ai/claude-haiku-4-5@20251001": {
      "inputUsdPerMillion": 1,
      "outputUsdPerMillion": 5,
      "cacheReadUsdPerMillion": 0.09999999999999999,
      "cacheWriteUsdPerMillion": 1.25,
      "provider": "vertex_ai-anthropic_models",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "vertex_ai/claude-3-5-sonnet": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 15,
      "provider": "vertex_ai-anthropic_models"
    },
    "vertex_ai/claude-3-5-sonnet@20240620": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 15,
      "provider": "vertex_ai-anthropic_models"
    },
    "vertex_ai/claude-3-haiku": {
      "inputUsdPerMillion": 0.25,
      "outputUsdPerMillion": 1.25,
      "provider": "vertex_ai-anthropic_models"
    },
    "vertex_ai/claude-3-haiku@20240307": {
      "inputUsdPerMillion": 0.25,
      "outputUsdPerMillion": 1.25,
      "provider": "vertex_ai-anthropic_models"
    },
    "vertex_ai/claude-3-opus": {
      "inputUsdPerMillion": 15,
      "outputUsdPerMillion": 75,
      "provider": "vertex_ai-anthropic_models"
    },
    "vertex_ai/claude-3-opus@20240229": {
      "inputUsdPerMillion": 15,
      "outputUsdPerMillion": 75,
      "provider": "vertex_ai-anthropic_models"
    },
    "vertex_ai/claude-3-sonnet": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 15,
      "provider": "vertex_ai-anthropic_models"
    },
    "vertex_ai/claude-3-sonnet@20240229": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 15,
      "provider": "vertex_ai-anthropic_models"
    },
    "vertex_ai/claude-opus-4-5": {
      "inputUsdPerMillion": 5,
      "outputUsdPerMillion": 25,
      "cacheReadUsdPerMillion": 0.5,
      "cacheWriteUsdPerMillion": 6.25,
      "provider": "vertex_ai-anthropic_models",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "vertex_ai/claude-opus-4-5@20251101": {
      "inputUsdPerMillion": 5,
      "outputUsdPerMillion": 25,
      "cacheReadUsdPerMillion": 0.5,
      "cacheWriteUsdPerMillion": 6.25,
      "provider": "vertex_ai-anthropic_models",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "vertex_ai/claude-opus-4-6": {
      "inputUsdPerMillion": 5,
      "outputUsdPerMillion": 25,
      "cacheReadUsdPerMillion": 0.5,
      "cacheWriteUsdPerMillion": 6.25,
      "provider": "vertex_ai-anthropic_models",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "vertex_ai/claude-opus-4-6@default": {
      "inputUsdPerMillion": 5,
      "outputUsdPerMillion": 25,
      "cacheReadUsdPerMillion": 0.5,
      "cacheWriteUsdPerMillion": 6.25,
      "provider": "vertex_ai-anthropic_models",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "vertex_ai/claude-opus-4-7": {
      "inputUsdPerMillion": 5,
      "outputUsdPerMillion": 25,
      "cacheReadUsdPerMillion": 0.5,
      "cacheWriteUsdPerMillion": 6.25,
      "provider": "vertex_ai-anthropic_models",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "vertex_ai/claude-opus-4-7@default": {
      "inputUsdPerMillion": 5,
      "outputUsdPerMillion": 25,
      "cacheReadUsdPerMillion": 0.5,
      "cacheWriteUsdPerMillion": 6.25,
      "provider": "vertex_ai-anthropic_models",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "vertex_ai/claude-fable-5": {
      "inputUsdPerMillion": 10,
      "outputUsdPerMillion": 50,
      "cacheReadUsdPerMillion": 1,
      "cacheWriteUsdPerMillion": 12.5,
      "provider": "vertex_ai-anthropic_models",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "vertex_ai/claude-fable-5-1": {
      "inputUsdPerMillion": 10,
      "outputUsdPerMillion": 50,
      "cacheReadUsdPerMillion": 0.25,
      "cacheWriteUsdPerMillion": 12.5,
      "provider": "vertex_ai-anthropic_models",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "vertex_ai/claude-fable-5@default": {
      "inputUsdPerMillion": 10,
      "outputUsdPerMillion": 50,
      "cacheReadUsdPerMillion": 1,
      "cacheWriteUsdPerMillion": 12.5,
      "provider": "vertex_ai-anthropic_models",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "vertex_ai/claude-fable-5-1@default": {
      "inputUsdPerMillion": 10,
      "outputUsdPerMillion": 50,
      "cacheReadUsdPerMillion": 0.25,
      "cacheWriteUsdPerMillion": 12.5,
      "provider": "vertex_ai-anthropic_models",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "vertex_ai/claude-opus-5": {
      "inputUsdPerMillion": 5,
      "outputUsdPerMillion": 25,
      "cacheReadUsdPerMillion": 0.5,
      "cacheWriteUsdPerMillion": 6.25,
      "provider": "vertex_ai-anthropic_models",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "vertex_ai/claude-opus-5@default": {
      "inputUsdPerMillion": 5,
      "outputUsdPerMillion": 25,
      "cacheReadUsdPerMillion": 0.5,
      "cacheWriteUsdPerMillion": 6.25,
      "provider": "vertex_ai-anthropic_models",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "vertex_ai/claude-opus-5-5": {
      "inputUsdPerMillion": 4,
      "outputUsdPerMillion": 20,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "cacheWriteUsdPerMillion": 5,
      "provider": "vertex_ai-anthropic_models",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "vertex_ai/claude-opus-5-5@default": {
      "inputUsdPerMillion": 4,
      "outputUsdPerMillion": 20,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "cacheWriteUsdPerMillion": 5,
      "provider": "vertex_ai-anthropic_models",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "vertex_ai/claude-opus-4-8": {
      "inputUsdPerMillion": 5,
      "outputUsdPerMillion": 25,
      "cacheReadUsdPerMillion": 0.5,
      "cacheWriteUsdPerMillion": 6.25,
      "provider": "vertex_ai-anthropic_models",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "vertex_ai/claude-opus-4-8@default": {
      "inputUsdPerMillion": 5,
      "outputUsdPerMillion": 25,
      "cacheReadUsdPerMillion": 0.5,
      "cacheWriteUsdPerMillion": 6.25,
      "provider": "vertex_ai-anthropic_models",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "vertex_ai/claude-sonnet-4-5": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 15,
      "cacheReadUsdPerMillion": 0.3,
      "cacheWriteUsdPerMillion": 3.75,
      "provider": "vertex_ai-anthropic_models",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "vertex_ai/claude-sonnet-5": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 10,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "cacheWriteUsdPerMillion": 2.5,
      "provider": "vertex_ai-anthropic_models",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "vertex_ai/claude-sonnet-4-6": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 15,
      "cacheReadUsdPerMillion": 0.3,
      "cacheWriteUsdPerMillion": 3.75,
      "provider": "vertex_ai-anthropic_models",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "vertex_ai/claude-sonnet-4-5@20250929": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 15,
      "cacheReadUsdPerMillion": 0.3,
      "cacheWriteUsdPerMillion": 3.75,
      "provider": "vertex_ai-anthropic_models",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "vertex_ai/mistralai/codestral-2@001": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 0.8999999999999999,
      "provider": "vertex_ai-mistral_models",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "vertex_ai/codestral-2": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 0.8999999999999999,
      "provider": "vertex_ai-mistral_models",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "vertex_ai/codestral-2@001": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 0.8999999999999999,
      "provider": "vertex_ai-mistral_models",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "vertex_ai/mistralai/codestral-2": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 0.8999999999999999,
      "provider": "vertex_ai-mistral_models",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "vertex_ai/codestral-2501": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.6,
      "provider": "vertex_ai-mistral_models"
    },
    "vertex_ai/codestral@2405": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.6,
      "provider": "vertex_ai-mistral_models"
    },
    "vertex_ai/codestral@latest": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.6,
      "provider": "vertex_ai-mistral_models"
    },
    "vertex_ai/deepseek-ai/deepseek-v3.1-maas": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 1.7,
      "cacheReadUsdPerMillion": 0.06,
      "provider": "vertex_ai-deepseek_models",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "vertex_ai/deepseek-ai/deepseek-v3.2-maas": {
      "inputUsdPerMillion": 0.56,
      "outputUsdPerMillion": 1.68,
      "cacheReadUsdPerMillion": 0.056,
      "provider": "vertex_ai-deepseek_models",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "vertex_ai/deepseek-ai/deepseek-r1-0528-maas": {
      "inputUsdPerMillion": 1.35,
      "outputUsdPerMillion": 5.4,
      "provider": "vertex_ai-deepseek_models",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "vertex_ai/gemini-3.1-flash-lite-preview": {
      "inputUsdPerMillion": 0.25,
      "outputUsdPerMillion": 1.5,
      "cacheReadUsdPerMillion": 0.024999999999999998,
      "reasoningUsdPerMillion": 1.5,
      "provider": "vertex_ai-language-models",
      "sourceUrl": "https://cloud.google.com/vertex-ai/generative-ai/pricing#gemini-models"
    },
    "vertex_ai/gemini-3.1-flash-lite": {
      "inputUsdPerMillion": 0.25,
      "outputUsdPerMillion": 1.5,
      "cacheReadUsdPerMillion": 0.024999999999999998,
      "reasoningUsdPerMillion": 1.5,
      "provider": "vertex_ai-language-models",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "vertex_ai/gemini-3.5-flash-lite": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 2.5,
      "cacheReadUsdPerMillion": 0.03,
      "reasoningUsdPerMillion": 2.5,
      "provider": "vertex_ai-language-models",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "vertex_ai/deep-research-pro-preview-12-2025": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 12,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "provider": "vertex_ai-language-models",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "vertex_ai/jamba-1.5": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.39999999999999997,
      "provider": "vertex_ai-ai21_models"
    },
    "vertex_ai/jamba-1.5-large": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 8,
      "provider": "vertex_ai-ai21_models"
    },
    "vertex_ai/jamba-1.5-large@001": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 8,
      "provider": "vertex_ai-ai21_models"
    },
    "vertex_ai/jamba-1.5-mini": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.39999999999999997,
      "provider": "vertex_ai-ai21_models"
    },
    "vertex_ai/jamba-1.5-mini@001": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.39999999999999997,
      "provider": "vertex_ai-ai21_models"
    },
    "vertex_ai/meta/llama-3.1-405b-instruct-maas": {
      "inputUsdPerMillion": 5,
      "outputUsdPerMillion": 16,
      "provider": "vertex_ai-llama_models",
      "sourceUrl": "https://console.cloud.google.com/vertex-ai/publishers/meta/model-garden/llama-3.2-90b-vision-instruct-maas"
    },
    "vertex_ai/meta/llama-3.1-70b-instruct-maas": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "vertex_ai-llama_models",
      "sourceUrl": "https://console.cloud.google.com/vertex-ai/publishers/meta/model-garden/llama-3.2-90b-vision-instruct-maas"
    },
    "vertex_ai/meta/llama-3.1-8b-instruct-maas": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "vertex_ai-llama_models",
      "sourceUrl": "https://console.cloud.google.com/vertex-ai/publishers/meta/model-garden/llama-3.2-90b-vision-instruct-maas"
    },
    "vertex_ai/meta/llama-3.2-90b-vision-instruct-maas": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "vertex_ai-llama_models",
      "sourceUrl": "https://console.cloud.google.com/vertex-ai/publishers/meta/model-garden/llama-3.2-90b-vision-instruct-maas"
    },
    "vertex_ai/meta/llama-4-maverick-17b-128e-instruct-maas": {
      "inputUsdPerMillion": 0.35,
      "outputUsdPerMillion": 1.15,
      "provider": "vertex_ai-llama_models",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "vertex_ai/meta/llama-4-maverick-17b-16e-instruct-maas": {
      "inputUsdPerMillion": 0.35,
      "outputUsdPerMillion": 1.15,
      "provider": "vertex_ai-llama_models",
      "sourceUrl": "https://cloud.google.com/vertex-ai/generative-ai/pricing#partner-models"
    },
    "vertex_ai/meta/llama-4-scout-17b-128e-instruct-maas": {
      "inputUsdPerMillion": 0.25,
      "outputUsdPerMillion": 0.7,
      "provider": "vertex_ai-llama_models",
      "sourceUrl": "https://cloud.google.com/vertex-ai/generative-ai/pricing#partner-models"
    },
    "vertex_ai/meta/llama-4-scout-17b-16e-instruct-maas": {
      "inputUsdPerMillion": 0.25,
      "outputUsdPerMillion": 0.7,
      "provider": "vertex_ai-llama_models",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "vertex_ai/meta/llama3-405b-instruct-maas": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "vertex_ai-llama_models",
      "sourceUrl": "https://cloud.google.com/vertex-ai/generative-ai/pricing#partner-models"
    },
    "vertex_ai/meta/llama3-70b-instruct-maas": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "vertex_ai-llama_models",
      "sourceUrl": "https://cloud.google.com/vertex-ai/generative-ai/pricing#partner-models"
    },
    "vertex_ai/meta/llama3-8b-instruct-maas": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "vertex_ai-llama_models",
      "sourceUrl": "https://cloud.google.com/vertex-ai/generative-ai/pricing#partner-models"
    },
    "vertex_ai/minimaxai/minimax-m2-maas": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 1.2,
      "cacheReadUsdPerMillion": 0.03,
      "provider": "vertex_ai-minimax_models",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "vertex_ai/moonshotai/kimi-k2-thinking-maas": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 2.5,
      "cacheReadUsdPerMillion": 0.06,
      "provider": "vertex_ai-moonshot_models",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "vertex_ai/zai-org/glm-4.7-maas": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 2.2,
      "cacheReadUsdPerMillion": 0.06,
      "provider": "vertex_ai-zai_models",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "vertex_ai/zai-org/glm-5-maas": {
      "inputUsdPerMillion": 1,
      "outputUsdPerMillion": 3.1999999999999997,
      "cacheReadUsdPerMillion": 0.09999999999999999,
      "provider": "vertex_ai-zai_models",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "vertex_ai/mistral-medium-3": {
      "inputUsdPerMillion": 0.39999999999999997,
      "outputUsdPerMillion": 2,
      "provider": "vertex_ai-mistral_models",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "vertex_ai/mistral-medium-3@001": {
      "inputUsdPerMillion": 0.39999999999999997,
      "outputUsdPerMillion": 2,
      "provider": "vertex_ai-mistral_models",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "vertex_ai/mistralai/mistral-medium-3": {
      "inputUsdPerMillion": 0.39999999999999997,
      "outputUsdPerMillion": 2,
      "provider": "vertex_ai-mistral_models",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "vertex_ai/mistralai/mistral-medium-3@001": {
      "inputUsdPerMillion": 0.39999999999999997,
      "outputUsdPerMillion": 2,
      "provider": "vertex_ai-mistral_models",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "vertex_ai/mistral-large-2411": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 6,
      "provider": "vertex_ai-mistral_models"
    },
    "vertex_ai/mistral-large@2407": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 6,
      "provider": "vertex_ai-mistral_models"
    },
    "vertex_ai/mistral-large@2411-001": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 6,
      "provider": "vertex_ai-mistral_models"
    },
    "vertex_ai/mistral-large@latest": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 6,
      "provider": "vertex_ai-mistral_models"
    },
    "vertex_ai/mistral-nemo@2407": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 3,
      "provider": "vertex_ai-mistral_models"
    },
    "vertex_ai/mistral-nemo@latest": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.15,
      "provider": "vertex_ai-mistral_models"
    },
    "vertex_ai/mistral-small-2503": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.3,
      "provider": "vertex_ai-mistral_models",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "vertex_ai/mistral-small-2503@001": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.3,
      "provider": "vertex_ai-mistral_models",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "vertex_ai/google/gemma-4-26b-a4b-it-maas": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.6,
      "cacheReadUsdPerMillion": 0.015,
      "provider": "vertex_ai-openai_models",
      "sourceUrl": "https://cloud.google.com/vertex-ai/generative-ai/docs/maas/google/gemma-4-26b-a4b-it"
    },
    "vertex_ai/openai/gpt-oss-120b-maas": {
      "inputUsdPerMillion": 0.09,
      "outputUsdPerMillion": 0.36,
      "provider": "vertex_ai-openai_models",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "vertex_ai/openai/gpt-oss-20b-maas": {
      "inputUsdPerMillion": 0.07,
      "outputUsdPerMillion": 0.25,
      "cacheReadUsdPerMillion": 0.007,
      "provider": "vertex_ai-openai_models",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "vertex_ai/xai/grok-4.1-fast-non-reasoning": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.5,
      "cacheReadUsdPerMillion": 0.049999999999999996,
      "provider": "vertex_ai",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "vertex_ai/xai/grok-4.1-fast-reasoning": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.5,
      "cacheReadUsdPerMillion": 0.049999999999999996,
      "provider": "vertex_ai",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "vertex_ai/xai/grok-4.20-non-reasoning": {
      "inputUsdPerMillion": 1.25,
      "outputUsdPerMillion": 2.5,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "provider": "vertex_ai",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "vertex_ai/xai/grok-4.20-reasoning": {
      "inputUsdPerMillion": 1.25,
      "outputUsdPerMillion": 2.5,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "provider": "vertex_ai",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "vertex_ai/xai/grok-4.3": {
      "inputUsdPerMillion": 1.25,
      "outputUsdPerMillion": 2.5,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "provider": "vertex_ai",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "vertex_ai/xai/grok-4.6": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 6,
      "cacheReadUsdPerMillion": 0.5,
      "provider": "vertex_ai",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "vertex_ai/qwen/qwen3-235b-a22b-instruct-2507-maas": {
      "inputUsdPerMillion": 0.22,
      "outputUsdPerMillion": 0.88,
      "provider": "vertex_ai-qwen_models",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "vertex_ai/qwen/qwen3-coder-480b-a35b-instruct-maas": {
      "inputUsdPerMillion": 0.22,
      "outputUsdPerMillion": 1.7999999999999998,
      "cacheReadUsdPerMillion": 0.022,
      "provider": "vertex_ai-qwen_models",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "vertex_ai/qwen/qwen3-next-80b-a3b-instruct-maas": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 1.2,
      "provider": "vertex_ai-qwen_models",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "vertex_ai/qwen/qwen3-next-80b-a3b-thinking-maas": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 1.2,
      "provider": "vertex_ai-qwen_models",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "wandb/openai/gpt-oss-120b": {
      "inputUsdPerMillion": 0.03,
      "outputUsdPerMillion": 0.16999999999999998,
      "provider": "wandb",
      "sourceUrl": "https://wandb.ai/site/pricing/tokens/"
    },
    "wandb/openai/gpt-oss-20b": {
      "inputUsdPerMillion": 0.03,
      "outputUsdPerMillion": 0.13,
      "provider": "wandb",
      "sourceUrl": "https://wandb.ai/site/pricing/tokens/"
    },
    "wandb/moonshotai/Kimi-K2.5": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 3,
      "cacheReadUsdPerMillion": 0.09999999999999999,
      "provider": "wandb",
      "sourceUrl": "https://wandb.ai/inference/coreweave/cw_moonshotai_Kimi-K2.5"
    },
    "wandb/meta-llama/Llama-3.1-8B-Instruct": {
      "inputUsdPerMillion": 0.22,
      "outputUsdPerMillion": 0.22,
      "provider": "wandb",
      "sourceUrl": "https://wandb.ai/site/pricing/tokens/"
    },
    "wandb/deepseek-ai/DeepSeek-V3.1": {
      "inputUsdPerMillion": 0.55,
      "outputUsdPerMillion": 1.6500000000000001,
      "provider": "wandb",
      "sourceUrl": "https://wandb.ai/site/pricing/tokens/"
    },
    "wandb/meta-llama/Llama-3.3-70B-Instruct": {
      "inputUsdPerMillion": 0.71,
      "outputUsdPerMillion": 0.71,
      "provider": "wandb",
      "sourceUrl": "https://wandb.ai/site/pricing/tokens/"
    },
    "watsonx/ibm/granite-3-8b-instruct": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "watsonx"
    },
    "watsonx/mistralai/mistral-large": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 10,
      "provider": "watsonx"
    },
    "watsonx/bigscience/mt0-xxl-13b": {
      "inputUsdPerMillion": 1.9080000000000001,
      "outputUsdPerMillion": 1.9080000000000001,
      "provider": "watsonx",
      "sourceUrl": "https://dataplatform.cloud.ibm.com/docs/content/wsj/analyze-data/fm-models.html?context=wx"
    },
    "watsonx/bigscience/mt0-xxl": {
      "inputUsdPerMillion": 1.9080000000000001,
      "outputUsdPerMillion": 1.9080000000000001,
      "provider": "watsonx",
      "sourceUrl": "https://dataplatform.cloud.ibm.com/docs/content/wsj/analyze-data/fm-models.html?context=wx"
    },
    "watsonx/core42/jais-13b-chat": {
      "inputUsdPerMillion": 500,
      "outputUsdPerMillion": 2000,
      "provider": "watsonx"
    },
    "watsonx/google/flan-t5-xl-3b": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 0.6,
      "provider": "watsonx"
    },
    "watsonx/ibm/granite-13b-chat-v2": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 0.6,
      "provider": "watsonx"
    },
    "watsonx/ibm/granite-13b-instruct-v2": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 0.6,
      "provider": "watsonx"
    },
    "watsonx/ibm/granite-3-3-8b-instruct": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "watsonx"
    },
    "watsonx/ibm/granite-4-h-small": {
      "inputUsdPerMillion": 0.0636,
      "outputUsdPerMillion": 0.265,
      "provider": "watsonx",
      "sourceUrl": "https://dataplatform.cloud.ibm.com/docs/content/wsj/analyze-data/fm-models.html?context=wx"
    },
    "watsonx/ibm/granite-guardian-3-2-2b": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.09999999999999999,
      "provider": "watsonx"
    },
    "watsonx/ibm/granite-guardian-3-3-8b": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "watsonx"
    },
    "watsonx/ibm/granite-ttm-1024-96-r2": {
      "inputUsdPerMillion": 0.38,
      "outputUsdPerMillion": 0.38,
      "provider": "watsonx"
    },
    "watsonx/ibm/granite-ttm-1536-96-r2": {
      "inputUsdPerMillion": 0.38,
      "outputUsdPerMillion": 0.38,
      "provider": "watsonx"
    },
    "watsonx/ibm/granite-ttm-512-96-r2": {
      "inputUsdPerMillion": 0.38,
      "outputUsdPerMillion": 0.38,
      "provider": "watsonx"
    },
    "watsonx/ibm/granite-vision-3-2-2b": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.09999999999999999,
      "provider": "watsonx"
    },
    "watsonx/meta-llama/llama-3-2-11b-vision-instruct": {
      "inputUsdPerMillion": 0.35,
      "outputUsdPerMillion": 0.35,
      "provider": "watsonx"
    },
    "watsonx/meta-llama/llama-3-2-1b-instruct": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.09999999999999999,
      "provider": "watsonx"
    },
    "watsonx/meta-llama/llama-3-2-3b-instruct": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.15,
      "provider": "watsonx"
    },
    "watsonx/meta-llama/llama-3-2-90b-vision-instruct": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 2,
      "provider": "watsonx"
    },
    "watsonx/meta-llama/llama-3-3-70b-instruct": {
      "inputUsdPerMillion": 0.7526,
      "outputUsdPerMillion": 0.7526,
      "provider": "watsonx",
      "sourceUrl": "https://dataplatform.cloud.ibm.com/docs/content/wsj/analyze-data/fm-models.html?context=wx"
    },
    "watsonx/meta-llama/llama-4-maverick-17b": {
      "inputUsdPerMillion": 0.371,
      "outputUsdPerMillion": 1.484,
      "provider": "watsonx",
      "sourceUrl": "https://dataplatform.cloud.ibm.com/docs/content/wsj/analyze-data/fm-models.html?context=wx"
    },
    "watsonx/meta-llama/llama-4-maverick-17b-128e-instruct-fp8": {
      "inputUsdPerMillion": 0.371,
      "outputUsdPerMillion": 1.484,
      "provider": "watsonx",
      "sourceUrl": "https://dataplatform.cloud.ibm.com/docs/content/wsj/analyze-data/fm-models.html?context=wx"
    },
    "watsonx/meta-llama/llama-guard-3-11b-vision": {
      "inputUsdPerMillion": 0.35,
      "outputUsdPerMillion": 0.35,
      "provider": "watsonx"
    },
    "watsonx/mistralai/mistral-medium-2505": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 10,
      "provider": "watsonx"
    },
    "watsonx/mistralai/mistral-small-2503": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.3,
      "provider": "watsonx"
    },
    "watsonx/mistralai/mistral-small-3-1-24b-instruct-2503": {
      "inputUsdPerMillion": 0.106,
      "outputUsdPerMillion": 0.318,
      "provider": "watsonx",
      "sourceUrl": "https://dataplatform.cloud.ibm.com/docs/content/wsj/analyze-data/fm-models.html?context=wx"
    },
    "watsonx/mistralai/pixtral-12b-2409": {
      "inputUsdPerMillion": 0.35,
      "outputUsdPerMillion": 0.35,
      "provider": "watsonx"
    },
    "watsonx/openai/gpt-oss-120b": {
      "inputUsdPerMillion": 0.159,
      "outputUsdPerMillion": 0.636,
      "provider": "watsonx",
      "sourceUrl": "https://dataplatform.cloud.ibm.com/docs/content/wsj/analyze-data/fm-models.html?context=wx"
    },
    "watsonx/sdaia/allam-1-13b-instruct": {
      "inputUsdPerMillion": 1.7999999999999998,
      "outputUsdPerMillion": 1.7999999999999998,
      "provider": "watsonx"
    },
    "xai/grok-4.20-beta-0309-reasoning": {
      "inputUsdPerMillion": 1.25,
      "outputUsdPerMillion": 2.5,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "provider": "xai",
      "sourceUrl": "https://api.x.ai/v1/language-models"
    },
    "xai/grok-4.20-0309-reasoning": {
      "inputUsdPerMillion": 1.25,
      "outputUsdPerMillion": 2.5,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "provider": "xai",
      "sourceUrl": "https://api.x.ai/v1/language-models"
    },
    "xai/grok-4.20-beta-0309-non-reasoning": {
      "inputUsdPerMillion": 1.25,
      "outputUsdPerMillion": 2.5,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "provider": "xai",
      "sourceUrl": "https://api.x.ai/v1/language-models"
    },
    "xai/grok-4.3": {
      "inputUsdPerMillion": 1.25,
      "outputUsdPerMillion": 2.5,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "provider": "xai",
      "sourceUrl": "https://api.x.ai/v1/language-models"
    },
    "xai/grok-4.3-latest": {
      "inputUsdPerMillion": 1.25,
      "outputUsdPerMillion": 2.5,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "provider": "xai",
      "sourceUrl": "https://api.x.ai/v1/language-models"
    },
    "xai/grok-4.5": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 6,
      "cacheReadUsdPerMillion": 0.3,
      "provider": "xai",
      "sourceUrl": "https://api.x.ai/v1/language-models"
    },
    "xai/grok-4.5-latest": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 6,
      "cacheReadUsdPerMillion": 0.3,
      "provider": "xai",
      "sourceUrl": "https://api.x.ai/v1/language-models"
    },
    "xai/grok-build-latest": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 6,
      "cacheReadUsdPerMillion": 0.3,
      "provider": "xai",
      "sourceUrl": "https://api.x.ai/v1/language-models"
    },
    "xai/grok-4.6": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 6,
      "cacheReadUsdPerMillion": 0.5,
      "provider": "xai",
      "sourceUrl": "https://api.x.ai/v1/language-models"
    },
    "xai/grok-4.7": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 6,
      "cacheReadUsdPerMillion": 0.5,
      "provider": "xai",
      "sourceUrl": "https://api.x.ai/v1/language-models"
    },
    "zai.glm-4.7": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 2.2,
      "provider": "bedrock_converse",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-zai-glm-4-7.html"
    },
    "zai.glm-5": {
      "inputUsdPerMillion": 1,
      "outputUsdPerMillion": 3.1999999999999997,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "zai.glm-4.7-flash": {
      "inputUsdPerMillion": 0.07,
      "outputUsdPerMillion": 0.39999999999999997,
      "provider": "bedrock_converse",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-zai-glm-4-7-flash.html"
    },
    "zai/glm-5": {
      "inputUsdPerMillion": 1,
      "outputUsdPerMillion": 3.1999999999999997,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "cacheWriteUsdPerMillion": 0,
      "provider": "zai",
      "sourceUrl": "https://docs.z.ai/guides/overview/pricing"
    },
    "zai/glm-5.3": {
      "inputUsdPerMillion": 1.4,
      "outputUsdPerMillion": 4.4,
      "cacheReadUsdPerMillion": 0.26,
      "cacheWriteUsdPerMillion": 0,
      "provider": "zai",
      "sourceUrl": "https://docs.z.ai/guides/overview/pricing"
    },
    "zai/glm-5.3-flash": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.5,
      "cacheReadUsdPerMillion": 0.03,
      "cacheWriteUsdPerMillion": 0,
      "provider": "zai",
      "sourceUrl": "https://docs.z.ai/guides/overview/pricing"
    },
    "zai/glm-5.1": {
      "inputUsdPerMillion": 1.4,
      "outputUsdPerMillion": 4.4,
      "cacheReadUsdPerMillion": 0.26,
      "cacheWriteUsdPerMillion": 0,
      "provider": "zai",
      "sourceUrl": "https://docs.z.ai/guides/overview/pricing"
    },
    "zai/glm-5-code": {
      "inputUsdPerMillion": 1.2,
      "outputUsdPerMillion": 5,
      "cacheReadUsdPerMillion": 0.3,
      "cacheWriteUsdPerMillion": 0,
      "provider": "zai",
      "sourceUrl": "https://docs.z.ai/guides/overview/pricing"
    },
    "zai/glm-4.7": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 2.2,
      "cacheReadUsdPerMillion": 0.11,
      "cacheWriteUsdPerMillion": 0,
      "provider": "zai",
      "sourceUrl": "https://docs.z.ai/guides/overview/pricing"
    },
    "zai/glm-4.7-flash": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "cacheReadUsdPerMillion": 0,
      "cacheWriteUsdPerMillion": 0,
      "provider": "zai",
      "sourceUrl": "https://docs.z.ai/guides/overview/pricing"
    },
    "zai/glm-4.6": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 2.2,
      "cacheReadUsdPerMillion": 0.11,
      "cacheWriteUsdPerMillion": 0,
      "provider": "zai",
      "sourceUrl": "https://docs.z.ai/guides/overview/pricing"
    },
    "zai/glm-4.5": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 2.2,
      "provider": "zai",
      "sourceUrl": "https://docs.z.ai/guides/overview/pricing"
    },
    "zai/glm-4.5v": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 1.7999999999999998,
      "provider": "zai",
      "sourceUrl": "https://docs.z.ai/guides/overview/pricing"
    },
    "zai/glm-4.5-x": {
      "inputUsdPerMillion": 2.2,
      "outputUsdPerMillion": 8.9,
      "provider": "zai",
      "sourceUrl": "https://docs.z.ai/guides/overview/pricing"
    },
    "zai/glm-4.5-air": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 1.1,
      "provider": "zai",
      "sourceUrl": "https://docs.z.ai/guides/overview/pricing"
    },
    "zai/glm-4.5-airx": {
      "inputUsdPerMillion": 1.1,
      "outputUsdPerMillion": 4.5,
      "provider": "zai",
      "sourceUrl": "https://docs.z.ai/guides/overview/pricing"
    },
    "zai/glm-4-32b-0414-128k": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.09999999999999999,
      "provider": "zai",
      "sourceUrl": "https://docs.z.ai/guides/overview/pricing"
    },
    "zai/glm-4.5-flash": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "zai",
      "sourceUrl": "https://docs.z.ai/guides/overview/pricing"
    },
    "fireworks_ai/accounts/fireworks/models/qwen3-coder-480b-a35b-instruct": {
      "inputUsdPerMillion": 0.44999999999999996,
      "outputUsdPerMillion": 1.7999999999999998,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/chronos-hermes-13b-v2": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/code-llama-13b": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/code-llama-13b-instruct": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/code-llama-13b-python": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/code-llama-34b": {
      "inputUsdPerMillion": 0.8999999999999999,
      "outputUsdPerMillion": 0.8999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/code-llama-34b-instruct": {
      "inputUsdPerMillion": 0.8999999999999999,
      "outputUsdPerMillion": 0.8999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/code-llama-34b-python": {
      "inputUsdPerMillion": 0.8999999999999999,
      "outputUsdPerMillion": 0.8999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/code-llama-70b": {
      "inputUsdPerMillion": 0.8999999999999999,
      "outputUsdPerMillion": 0.8999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/code-llama-70b-instruct": {
      "inputUsdPerMillion": 0.8999999999999999,
      "outputUsdPerMillion": 0.8999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/code-llama-70b-python": {
      "inputUsdPerMillion": 0.8999999999999999,
      "outputUsdPerMillion": 0.8999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/code-llama-7b": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/code-llama-7b-instruct": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/code-llama-7b-python": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/code-qwen-1p5-7b": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/codegemma-2b": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.09999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/codegemma-7b": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/cogito-671b-v2-p1": {
      "inputUsdPerMillion": 1.2,
      "outputUsdPerMillion": 1.2,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/cogito-v1-preview-llama-3b": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.09999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/cogito-v1-preview-llama-70b": {
      "inputUsdPerMillion": 0.8999999999999999,
      "outputUsdPerMillion": 0.8999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/cogito-v1-preview-llama-8b": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/cogito-v1-preview-qwen-14b": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/cogito-v1-preview-qwen-32b": {
      "inputUsdPerMillion": 0.8999999999999999,
      "outputUsdPerMillion": 0.8999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/dbrx-instruct": {
      "inputUsdPerMillion": 1.2,
      "outputUsdPerMillion": 1.2,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/deepseek-coder-1b-base": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.09999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/deepseek-coder-33b-instruct": {
      "inputUsdPerMillion": 0.8999999999999999,
      "outputUsdPerMillion": 0.8999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/deepseek-coder-7b-base": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/deepseek-coder-7b-base-v1p5": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/deepseek-coder-7b-instruct-v1p5": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/deepseek-coder-v2-lite-base": {
      "inputUsdPerMillion": 0.5,
      "outputUsdPerMillion": 0.5,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/deepseek-coder-v2-lite-instruct": {
      "inputUsdPerMillion": 0.5,
      "outputUsdPerMillion": 0.5,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/deepseek-prover-v2": {
      "inputUsdPerMillion": 1.2,
      "outputUsdPerMillion": 1.2,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/deepseek-r1-0528-distill-qwen3-8b": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/deepseek-r1-distill-llama-70b": {
      "inputUsdPerMillion": 0.8999999999999999,
      "outputUsdPerMillion": 0.8999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/deepseek-r1-distill-llama-8b": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/deepseek-r1-distill-qwen-14b": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/deepseek-r1-distill-qwen-1p5b": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.09999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/deepseek-r1-distill-qwen-32b": {
      "inputUsdPerMillion": 0.8999999999999999,
      "outputUsdPerMillion": 0.8999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/deepseek-r1-distill-qwen-7b": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/deepseek-v2-lite-chat": {
      "inputUsdPerMillion": 0.5,
      "outputUsdPerMillion": 0.5,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/deepseek-v2p5": {
      "inputUsdPerMillion": 1.2,
      "outputUsdPerMillion": 1.2,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/devstral-small-2505": {
      "inputUsdPerMillion": 0.8999999999999999,
      "outputUsdPerMillion": 0.8999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/dobby-mini-unhinged-plus-llama-3-1-8b": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/dobby-unhinged-llama-3-3-70b-new": {
      "inputUsdPerMillion": 0.8999999999999999,
      "outputUsdPerMillion": 0.8999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/dolphin-2-9-2-qwen2-72b": {
      "inputUsdPerMillion": 0.8999999999999999,
      "outputUsdPerMillion": 0.8999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/dolphin-2p6-mixtral-8x7b": {
      "inputUsdPerMillion": 0.5,
      "outputUsdPerMillion": 0.5,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/ernie-4p5-21b-a3b-pt": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.09999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/ernie-4p5-300b-a47b-pt": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.09999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/fare-20b": {
      "inputUsdPerMillion": 0.8999999999999999,
      "outputUsdPerMillion": 0.8999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/firefunction-v1": {
      "inputUsdPerMillion": 0.5,
      "outputUsdPerMillion": 0.5,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/firellava-13b": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/firesearch-ocr-v6": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/flux-1-dev": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.09999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/flux-1-dev-controlnet-union": {
      "inputUsdPerMillion": 0.001,
      "outputUsdPerMillion": 0.001,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/flux-1-schnell": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.09999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/gemma-2b-it": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.09999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/gemma-3-27b-it": {
      "inputUsdPerMillion": 0.8999999999999999,
      "outputUsdPerMillion": 0.8999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/gemma-7b": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/gemma-7b-it": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/gemma2-9b-it": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/glm-4p5v": {
      "inputUsdPerMillion": 1.2,
      "outputUsdPerMillion": 1.2,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/gpt-oss-safeguard-120b": {
      "inputUsdPerMillion": 1.2,
      "outputUsdPerMillion": 1.2,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/gpt-oss-safeguard-20b": {
      "inputUsdPerMillion": 0.5,
      "outputUsdPerMillion": 0.5,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/hermes-2-pro-mistral-7b": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/internvl3-38b": {
      "inputUsdPerMillion": 0.8999999999999999,
      "outputUsdPerMillion": 0.8999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/internvl3-78b": {
      "inputUsdPerMillion": 0.8999999999999999,
      "outputUsdPerMillion": 0.8999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/internvl3-8b": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/kat-coder": {
      "inputUsdPerMillion": 0.8999999999999999,
      "outputUsdPerMillion": 0.8999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/kat-dev-32b": {
      "inputUsdPerMillion": 0.8999999999999999,
      "outputUsdPerMillion": 0.8999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/kat-dev-72b-exp": {
      "inputUsdPerMillion": 0.8999999999999999,
      "outputUsdPerMillion": 0.8999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/llama-guard-2-8b": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/llama-guard-3-1b": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.09999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/llama-guard-3-8b": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/llama-v2-13b": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/llama-v2-13b-chat": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/llama-v2-70b": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.09999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/llama-v2-70b-chat": {
      "inputUsdPerMillion": 0.8999999999999999,
      "outputUsdPerMillion": 0.8999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/llama-v2-7b": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/llama-v2-7b-chat": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/llama-v3-70b-instruct": {
      "inputUsdPerMillion": 0.8999999999999999,
      "outputUsdPerMillion": 0.8999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/llama-v3-70b-instruct-hf": {
      "inputUsdPerMillion": 0.8999999999999999,
      "outputUsdPerMillion": 0.8999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/llama-v3-8b": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/llama-v3-8b-instruct-hf": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/llama-v3p1-405b-instruct-long": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.09999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/llama-v3p1-70b-instruct": {
      "inputUsdPerMillion": 0.8999999999999999,
      "outputUsdPerMillion": 0.8999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/llama-v3p1-70b-instruct-1b": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.09999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/llama-v3p1-nemotron-70b-instruct": {
      "inputUsdPerMillion": 0.8999999999999999,
      "outputUsdPerMillion": 0.8999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/llama-v3p2-1b": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.09999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/llama-v3p2-3b": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.09999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/llama-v3p3-70b-instruct": {
      "inputUsdPerMillion": 0.8999999999999999,
      "outputUsdPerMillion": 0.8999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/llamaguard-7b": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/llava-yi-34b": {
      "inputUsdPerMillion": 0.8999999999999999,
      "outputUsdPerMillion": 0.8999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/minimax-m1-80k": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.09999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/minimax-m2": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 1.2,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/ministral-3-14b-instruct-2512": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/ministral-3-3b-instruct-2512": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.09999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/ministral-3-8b-instruct-2512": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/mistral-7b": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/mistral-7b-instruct-4k": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/mistral-7b-instruct-v0p2": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/mistral-7b-instruct-v3": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/mistral-7b-v0p2": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/mistral-large-3-fp8": {
      "inputUsdPerMillion": 1.2,
      "outputUsdPerMillion": 1.2,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/mistral-nemo-base-2407": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/mistral-nemo-instruct-2407": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/mistral-small-24b-instruct-2501": {
      "inputUsdPerMillion": 0.8999999999999999,
      "outputUsdPerMillion": 0.8999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/mixtral-8x22b": {
      "inputUsdPerMillion": 1.2,
      "outputUsdPerMillion": 1.2,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/mixtral-8x22b-instruct": {
      "inputUsdPerMillion": 1.2,
      "outputUsdPerMillion": 1.2,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/mixtral-8x7b": {
      "inputUsdPerMillion": 0.5,
      "outputUsdPerMillion": 0.5,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/mixtral-8x7b-instruct": {
      "inputUsdPerMillion": 0.5,
      "outputUsdPerMillion": 0.5,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/mixtral-8x7b-instruct-hf": {
      "inputUsdPerMillion": 0.5,
      "outputUsdPerMillion": 0.5,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/mythomax-l2-13b": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/nemotron-nano-v2-12b-vl": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.09999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/nous-capybara-7b-v1p9": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/nous-hermes-2-mixtral-8x7b-dpo": {
      "inputUsdPerMillion": 0.5,
      "outputUsdPerMillion": 0.5,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/nous-hermes-2-yi-34b": {
      "inputUsdPerMillion": 0.8999999999999999,
      "outputUsdPerMillion": 0.8999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/nous-hermes-llama2-13b": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/nous-hermes-llama2-70b": {
      "inputUsdPerMillion": 0.8999999999999999,
      "outputUsdPerMillion": 0.8999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/nous-hermes-llama2-7b": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/nvidia-nemotron-nano-12b-v2": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/nvidia-nemotron-nano-9b-v2": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/openchat-3p5-0106-7b": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/openhermes-2-mistral-7b": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/openhermes-2p5-mistral-7b": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/openorca-7b": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/phi-2-3b": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.09999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/phi-3-mini-128k-instruct": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.09999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/phi-3-vision-128k-instruct": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/phind-code-llama-34b-python-v1": {
      "inputUsdPerMillion": 0.8999999999999999,
      "outputUsdPerMillion": 0.8999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/phind-code-llama-34b-v1": {
      "inputUsdPerMillion": 0.8999999999999999,
      "outputUsdPerMillion": 0.8999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/phind-code-llama-34b-v2": {
      "inputUsdPerMillion": 0.8999999999999999,
      "outputUsdPerMillion": 0.8999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/pythia-12b": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/qwen-qwq-32b-preview": {
      "inputUsdPerMillion": 0.8999999999999999,
      "outputUsdPerMillion": 0.8999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/qwen-v2p5-14b-instruct": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/qwen-v2p5-7b": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/qwen1p5-72b-chat": {
      "inputUsdPerMillion": 0.8999999999999999,
      "outputUsdPerMillion": 0.8999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/qwen2-7b-instruct": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/qwen2-vl-2b-instruct": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.09999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/qwen2-vl-72b-instruct": {
      "inputUsdPerMillion": 0.8999999999999999,
      "outputUsdPerMillion": 0.8999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/qwen2-vl-7b-instruct": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/qwen2p5-0p5b-instruct": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.09999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/qwen2p5-14b": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/qwen2p5-1p5b-instruct": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.09999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/qwen2p5-32b": {
      "inputUsdPerMillion": 0.8999999999999999,
      "outputUsdPerMillion": 0.8999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/qwen2p5-32b-instruct": {
      "inputUsdPerMillion": 0.8999999999999999,
      "outputUsdPerMillion": 0.8999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/qwen2p5-72b": {
      "inputUsdPerMillion": 0.8999999999999999,
      "outputUsdPerMillion": 0.8999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/qwen2p5-72b-instruct": {
      "inputUsdPerMillion": 0.8999999999999999,
      "outputUsdPerMillion": 0.8999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/qwen2p5-7b-instruct": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/qwen2p5-coder-0p5b": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.09999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/qwen2p5-coder-0p5b-instruct": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.09999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/qwen2p5-coder-14b": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/qwen2p5-coder-14b-instruct": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/qwen2p5-coder-1p5b": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.09999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/qwen2p5-coder-1p5b-instruct": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.09999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/qwen2p5-coder-32b": {
      "inputUsdPerMillion": 0.8999999999999999,
      "outputUsdPerMillion": 0.8999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/qwen2p5-coder-32b-instruct-128k": {
      "inputUsdPerMillion": 0.8999999999999999,
      "outputUsdPerMillion": 0.8999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/qwen2p5-coder-32b-instruct-32k-rope": {
      "inputUsdPerMillion": 0.8999999999999999,
      "outputUsdPerMillion": 0.8999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/qwen2p5-coder-32b-instruct-64k": {
      "inputUsdPerMillion": 0.8999999999999999,
      "outputUsdPerMillion": 0.8999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/qwen2p5-coder-3b": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.09999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/qwen2p5-coder-3b-instruct": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.09999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/qwen2p5-coder-7b": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/qwen2p5-coder-7b-instruct": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/qwen2p5-math-72b-instruct": {
      "inputUsdPerMillion": 0.8999999999999999,
      "outputUsdPerMillion": 0.8999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/qwen2p5-vl-32b-instruct": {
      "inputUsdPerMillion": 0.8999999999999999,
      "outputUsdPerMillion": 0.8999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/qwen2p5-vl-3b-instruct": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/qwen2p5-vl-72b-instruct": {
      "inputUsdPerMillion": 0.8999999999999999,
      "outputUsdPerMillion": 0.8999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/qwen2p5-vl-7b-instruct": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/qwen3-0p6b": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.09999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/qwen3-14b": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/qwen3-1p7b": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.09999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/qwen3-1p7b-fp8-draft": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.09999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/qwen3-1p7b-fp8-draft-131072": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.09999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/qwen3-1p7b-fp8-draft-40960": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.09999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/qwen3-235b-a22b": {
      "inputUsdPerMillion": 0.22,
      "outputUsdPerMillion": 0.88,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/qwen3-235b-a22b-instruct-2507": {
      "inputUsdPerMillion": 0.22,
      "outputUsdPerMillion": 0.88,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/qwen3-235b-a22b-thinking-2507": {
      "inputUsdPerMillion": 0.22,
      "outputUsdPerMillion": 0.88,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/qwen3-30b-a3b": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.6,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/qwen3-30b-a3b-instruct-2507": {
      "inputUsdPerMillion": 0.5,
      "outputUsdPerMillion": 0.5,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/qwen3-30b-a3b-thinking-2507": {
      "inputUsdPerMillion": 0.8999999999999999,
      "outputUsdPerMillion": 0.8999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/qwen3-32b": {
      "inputUsdPerMillion": 0.8999999999999999,
      "outputUsdPerMillion": 0.8999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/qwen3-4b": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/qwen3-4b-instruct-2507": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/qwen3-8b": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/qwen3-coder-30b-a3b-instruct": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.6,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/qwen3-coder-480b-instruct-bf16": {
      "inputUsdPerMillion": 0.8999999999999999,
      "outputUsdPerMillion": 0.8999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/qwen3-next-80b-a3b-instruct": {
      "inputUsdPerMillion": 0.8999999999999999,
      "outputUsdPerMillion": 0.8999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/qwen3-next-80b-a3b-thinking": {
      "inputUsdPerMillion": 0.8999999999999999,
      "outputUsdPerMillion": 0.8999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/qwen3-vl-235b-a22b-instruct": {
      "inputUsdPerMillion": 0.22,
      "outputUsdPerMillion": 0.88,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/qwen3-vl-235b-a22b-thinking": {
      "inputUsdPerMillion": 0.22,
      "outputUsdPerMillion": 0.88,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/qwen3-vl-30b-a3b-instruct": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.6,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/qwen3-vl-30b-a3b-thinking": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.6,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/qwen3-vl-32b-instruct": {
      "inputUsdPerMillion": 0.8999999999999999,
      "outputUsdPerMillion": 0.8999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/qwen3-vl-8b-instruct": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/qwen3p7-plus": {
      "inputUsdPerMillion": 0.39999999999999997,
      "outputUsdPerMillion": 1.5999999999999999,
      "cacheReadUsdPerMillion": 0.08,
      "provider": "fireworks_ai",
      "sourceUrl": "https://api.fireworks.ai/v1/serverless/models"
    },
    "fireworks_ai/accounts/fireworks/models/qwq-32b": {
      "inputUsdPerMillion": 0.8999999999999999,
      "outputUsdPerMillion": 0.8999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/rolm-ocr": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/snorkel-mistral-7b-pairrm-dpo": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/stablecode-3b": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.09999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/starcoder-16b": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/starcoder-7b": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/starcoder2-15b": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/starcoder2-3b": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.09999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/starcoder2-7b": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/toppy-m-7b": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/yi-34b": {
      "inputUsdPerMillion": 0.8999999999999999,
      "outputUsdPerMillion": 0.8999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/yi-34b-200k-capybara": {
      "inputUsdPerMillion": 0.8999999999999999,
      "outputUsdPerMillion": 0.8999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/yi-34b-chat": {
      "inputUsdPerMillion": 0.8999999999999999,
      "outputUsdPerMillion": 0.8999999999999999,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/yi-6b": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/models/zephyr-7b-beta": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "fireworks_ai"
    },
    "fireworks_ai/accounts/fireworks/routers/glm-5p1-fast": {
      "inputUsdPerMillion": 2.8,
      "outputUsdPerMillion": 8.8,
      "cacheReadUsdPerMillion": 0.52,
      "provider": "fireworks_ai",
      "sourceUrl": "https://docs.fireworks.ai/serverless/pricing"
    },
    "fireworks_ai/accounts/fireworks/routers/kimi-k2p6-fast": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 8,
      "cacheReadUsdPerMillion": 0.3,
      "provider": "fireworks_ai",
      "sourceUrl": "https://docs.fireworks.ai/serverless/pricing"
    },
    "fireworks_ai/accounts/fireworks/routers/kimi-k2p7-code-fast": {
      "inputUsdPerMillion": 1.9,
      "outputUsdPerMillion": 8,
      "cacheReadUsdPerMillion": 0.38,
      "provider": "fireworks_ai",
      "sourceUrl": "https://docs.fireworks.ai/serverless/pricing"
    },
    "scaleway/qwen/qwen3.5-397b-a17b": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 3.5999999999999996,
      "provider": "scaleway"
    },
    "scaleway/qwen/qwen3.6-35b-a3b": {
      "inputUsdPerMillion": 0.25,
      "outputUsdPerMillion": 1.5,
      "provider": "scaleway"
    },
    "scaleway/qwen/qwen3-235b-a22b-instruct-2507": {
      "inputUsdPerMillion": 0.75,
      "outputUsdPerMillion": 2.25,
      "provider": "scaleway"
    },
    "scaleway/qwen/qwen3-coder-30b-a3b-instruct": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.7999999999999999,
      "provider": "scaleway"
    },
    "scaleway/openai/gpt-oss-120b": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.6,
      "provider": "scaleway"
    },
    "scaleway/google/gemma-4-26b-a4b-it": {
      "inputUsdPerMillion": 0.25,
      "outputUsdPerMillion": 0.5,
      "provider": "scaleway"
    },
    "scaleway/mistralai/mistral-medium-3.5-128b": {
      "inputUsdPerMillion": 1.5,
      "outputUsdPerMillion": 7.5,
      "provider": "scaleway"
    },
    "scaleway/mistralai/mistral-small-3.2-24b-instruct-2506": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.35,
      "provider": "scaleway"
    },
    "scaleway/mistralai/pixtral-12b-2409": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "scaleway"
    },
    "scaleway/meta/llama-3.3-70b-instruct": {
      "inputUsdPerMillion": 0.8999999999999999,
      "outputUsdPerMillion": 0.8999999999999999,
      "provider": "scaleway"
    },
    "novita/deepseek/deepseek-v3.2": {
      "inputUsdPerMillion": 0.26899999999999996,
      "outputUsdPerMillion": 0.39999999999999997,
      "cacheReadUsdPerMillion": 0.13449999999999998,
      "provider": "novita"
    },
    "novita/minimax/minimax-m2.1": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 1.2,
      "cacheReadUsdPerMillion": 0.03,
      "provider": "novita"
    },
    "novita/zai-org/glm-4.7": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 2.2,
      "cacheReadUsdPerMillion": 0.11,
      "provider": "novita"
    },
    "novita/xiaomimimo/mimo-v2-flash": {
      "inputUsdPerMillion": 0.11,
      "outputUsdPerMillion": 0.33,
      "cacheReadUsdPerMillion": 0.024,
      "provider": "novita"
    },
    "novita/zai-org/autoglm-phone-9b-multilingual": {
      "inputUsdPerMillion": 0.035,
      "outputUsdPerMillion": 0.13799999999999998,
      "provider": "novita"
    },
    "novita/moonshotai/kimi-k2-thinking": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 2.5,
      "cacheReadUsdPerMillion": 0.15,
      "provider": "novita"
    },
    "novita/minimax/minimax-m2": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 1.2,
      "cacheReadUsdPerMillion": 0.03,
      "provider": "novita"
    },
    "novita/paddlepaddle/paddleocr-vl": {
      "inputUsdPerMillion": 0.02,
      "outputUsdPerMillion": 0.02,
      "provider": "novita"
    },
    "novita/deepseek/deepseek-v3.2-exp": {
      "inputUsdPerMillion": 0.27,
      "outputUsdPerMillion": 0.41,
      "provider": "novita"
    },
    "novita/qwen/qwen3-vl-235b-a22b-thinking": {
      "inputUsdPerMillion": 0.98,
      "outputUsdPerMillion": 3.95,
      "provider": "novita"
    },
    "novita/zai-org/glm-4.6v": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 0.8999999999999999,
      "cacheReadUsdPerMillion": 0.055,
      "provider": "novita"
    },
    "novita/zai-org/glm-4.6": {
      "inputUsdPerMillion": 0.55,
      "outputUsdPerMillion": 2.2,
      "cacheReadUsdPerMillion": 0.11,
      "provider": "novita"
    },
    "novita/kwaipilot/kat-coder-pro": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 1.2,
      "cacheReadUsdPerMillion": 0.06,
      "provider": "novita"
    },
    "novita/qwen/qwen3-next-80b-a3b-instruct": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 1.5,
      "provider": "novita"
    },
    "novita/qwen/qwen3-next-80b-a3b-thinking": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 1.5,
      "provider": "novita"
    },
    "novita/deepseek/deepseek-ocr": {
      "inputUsdPerMillion": 0.03,
      "outputUsdPerMillion": 0.03,
      "provider": "novita"
    },
    "novita/deepseek/deepseek-v3.1-terminus": {
      "inputUsdPerMillion": 0.27,
      "outputUsdPerMillion": 1,
      "cacheReadUsdPerMillion": 0.135,
      "provider": "novita"
    },
    "novita/qwen/qwen3-vl-235b-a22b-instruct": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 1.5,
      "provider": "novita"
    },
    "novita/qwen/qwen3-max": {
      "inputUsdPerMillion": 2.1100000000000003,
      "outputUsdPerMillion": 8.450000000000001,
      "provider": "novita"
    },
    "novita/skywork/r1v4-lite": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.6,
      "provider": "novita"
    },
    "novita/deepseek/deepseek-v3.1": {
      "inputUsdPerMillion": 0.27,
      "outputUsdPerMillion": 1,
      "cacheReadUsdPerMillion": 0.135,
      "provider": "novita"
    },
    "novita/moonshotai/kimi-k2-0905": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 2.5,
      "provider": "novita"
    },
    "novita/qwen/qwen3-coder-480b-a35b-instruct": {
      "inputUsdPerMillion": 0.38,
      "outputUsdPerMillion": 1.55,
      "provider": "novita"
    },
    "novita/qwen/qwen3-coder-30b-a3b-instruct": {
      "inputUsdPerMillion": 0.07,
      "outputUsdPerMillion": 0.27,
      "provider": "novita"
    },
    "novita/openai/gpt-oss-120b": {
      "inputUsdPerMillion": 0.049999999999999996,
      "outputUsdPerMillion": 0.25,
      "provider": "novita"
    },
    "novita/moonshotai/kimi-k2-instruct": {
      "inputUsdPerMillion": 0.5700000000000001,
      "outputUsdPerMillion": 2.3,
      "provider": "novita"
    },
    "novita/deepseek/deepseek-v3-0324": {
      "inputUsdPerMillion": 0.27,
      "outputUsdPerMillion": 1.12,
      "cacheReadUsdPerMillion": 0.135,
      "provider": "novita"
    },
    "novita/zai-org/glm-4.5": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 2.2,
      "cacheReadUsdPerMillion": 0.11,
      "provider": "novita"
    },
    "novita/qwen/qwen3-235b-a22b-thinking-2507": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 3,
      "provider": "novita"
    },
    "novita/meta-llama/llama-3.1-8b-instruct": {
      "inputUsdPerMillion": 0.02,
      "outputUsdPerMillion": 0.049999999999999996,
      "provider": "novita"
    },
    "novita/google/gemma-3-12b-it": {
      "inputUsdPerMillion": 0.049999999999999996,
      "outputUsdPerMillion": 0.09999999999999999,
      "provider": "novita"
    },
    "novita/zai-org/glm-4.5v": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 1.7999999999999998,
      "cacheReadUsdPerMillion": 0.11,
      "provider": "novita"
    },
    "novita/openai/gpt-oss-20b": {
      "inputUsdPerMillion": 0.04,
      "outputUsdPerMillion": 0.15,
      "provider": "novita"
    },
    "novita/qwen/qwen3-235b-a22b-instruct-2507": {
      "inputUsdPerMillion": 0.09,
      "outputUsdPerMillion": 0.58,
      "provider": "novita"
    },
    "novita/deepseek/deepseek-r1-distill-qwen-14b": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.15,
      "provider": "novita"
    },
    "novita/meta-llama/llama-3.3-70b-instruct": {
      "inputUsdPerMillion": 0.135,
      "outputUsdPerMillion": 0.39999999999999997,
      "provider": "novita"
    },
    "novita/qwen/qwen-2.5-72b-instruct": {
      "inputUsdPerMillion": 0.38,
      "outputUsdPerMillion": 0.39999999999999997,
      "provider": "novita"
    },
    "novita/mistralai/mistral-nemo": {
      "inputUsdPerMillion": 0.04,
      "outputUsdPerMillion": 0.16999999999999998,
      "provider": "novita"
    },
    "novita/minimaxai/minimax-m1-80k": {
      "inputUsdPerMillion": 0.55,
      "outputUsdPerMillion": 2.2,
      "provider": "novita"
    },
    "novita/deepseek/deepseek-r1-0528": {
      "inputUsdPerMillion": 0.7,
      "outputUsdPerMillion": 2.5,
      "cacheReadUsdPerMillion": 0.35,
      "provider": "novita"
    },
    "novita/deepseek/deepseek-r1-distill-qwen-32b": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 0.3,
      "provider": "novita"
    },
    "novita/meta-llama/llama-3-8b-instruct": {
      "inputUsdPerMillion": 0.04,
      "outputUsdPerMillion": 0.04,
      "provider": "novita"
    },
    "novita/microsoft/wizardlm-2-8x22b": {
      "inputUsdPerMillion": 0.62,
      "outputUsdPerMillion": 0.62,
      "provider": "novita"
    },
    "novita/deepseek/deepseek-r1-0528-qwen3-8b": {
      "inputUsdPerMillion": 0.06,
      "outputUsdPerMillion": 0.09,
      "provider": "novita"
    },
    "novita/deepseek/deepseek-r1-distill-llama-70b": {
      "inputUsdPerMillion": 0.7999999999999999,
      "outputUsdPerMillion": 0.7999999999999999,
      "provider": "novita"
    },
    "novita/meta-llama/llama-3-70b-instruct": {
      "inputUsdPerMillion": 0.51,
      "outputUsdPerMillion": 0.74,
      "provider": "novita"
    },
    "novita/qwen/qwen3-235b-a22b-fp8": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.7999999999999999,
      "provider": "novita"
    },
    "novita/meta-llama/llama-4-maverick-17b-128e-instruct-fp8": {
      "inputUsdPerMillion": 0.27,
      "outputUsdPerMillion": 0.85,
      "provider": "novita"
    },
    "novita/meta-llama/llama-4-scout-17b-16e-instruct": {
      "inputUsdPerMillion": 0.18,
      "outputUsdPerMillion": 0.59,
      "provider": "novita"
    },
    "novita/nousresearch/hermes-2-pro-llama-3-8b": {
      "inputUsdPerMillion": 0.14,
      "outputUsdPerMillion": 0.14,
      "provider": "novita"
    },
    "novita/qwen/qwen2.5-vl-72b-instruct": {
      "inputUsdPerMillion": 0.7999999999999999,
      "outputUsdPerMillion": 0.7999999999999999,
      "provider": "novita"
    },
    "novita/sao10k/l3-70b-euryale-v2.1": {
      "inputUsdPerMillion": 1.48,
      "outputUsdPerMillion": 1.48,
      "provider": "novita"
    },
    "novita/baidu/ernie-4.5-21B-a3b-thinking": {
      "inputUsdPerMillion": 0.07,
      "outputUsdPerMillion": 0.28,
      "provider": "novita"
    },
    "novita/sao10k/l3-8b-lunaris": {
      "inputUsdPerMillion": 0.049999999999999996,
      "outputUsdPerMillion": 0.049999999999999996,
      "provider": "novita"
    },
    "novita/baichuan/baichuan-m2-32b": {
      "inputUsdPerMillion": 0.07,
      "outputUsdPerMillion": 0.07,
      "provider": "novita"
    },
    "novita/baidu/ernie-4.5-vl-424b-a47b": {
      "inputUsdPerMillion": 0.42,
      "outputUsdPerMillion": 1.25,
      "provider": "novita"
    },
    "novita/baidu/ernie-4.5-300b-a47b-paddle": {
      "inputUsdPerMillion": 0.28,
      "outputUsdPerMillion": 1.1,
      "provider": "novita"
    },
    "novita/deepseek/deepseek-prover-v2-671b": {
      "inputUsdPerMillion": 0.7,
      "outputUsdPerMillion": 2.5,
      "provider": "novita"
    },
    "novita/qwen/qwen3-32b-fp8": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.44999999999999996,
      "provider": "novita"
    },
    "novita/qwen/qwen3-30b-a3b-fp8": {
      "inputUsdPerMillion": 0.09,
      "outputUsdPerMillion": 0.44999999999999996,
      "provider": "novita"
    },
    "novita/google/gemma-3-27b-it": {
      "inputUsdPerMillion": 0.119,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "novita"
    },
    "novita/deepseek/deepseek-v3-turbo": {
      "inputUsdPerMillion": 0.39999999999999997,
      "outputUsdPerMillion": 1.3,
      "provider": "novita"
    },
    "novita/deepseek/deepseek-r1-turbo": {
      "inputUsdPerMillion": 0.7,
      "outputUsdPerMillion": 2.5,
      "provider": "novita"
    },
    "novita/Sao10K/L3-8B-Stheno-v3.2": {
      "inputUsdPerMillion": 0.049999999999999996,
      "outputUsdPerMillion": 0.049999999999999996,
      "provider": "novita"
    },
    "novita/gryphe/mythomax-l2-13b": {
      "inputUsdPerMillion": 0.09,
      "outputUsdPerMillion": 0.09,
      "provider": "novita"
    },
    "novita/baidu/ernie-4.5-vl-28b-a3b-thinking": {
      "inputUsdPerMillion": 0.39,
      "outputUsdPerMillion": 0.39,
      "provider": "novita"
    },
    "novita/qwen/qwen3-vl-8b-instruct": {
      "inputUsdPerMillion": 0.08,
      "outputUsdPerMillion": 0.5,
      "provider": "novita"
    },
    "novita/zai-org/glm-4.5-air": {
      "inputUsdPerMillion": 0.13,
      "outputUsdPerMillion": 0.85,
      "cacheReadUsdPerMillion": 0.024999999999999998,
      "provider": "novita"
    },
    "novita/qwen/qwen3-vl-30b-a3b-instruct": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.7,
      "provider": "novita"
    },
    "novita/qwen/qwen3-vl-30b-a3b-thinking": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 1,
      "provider": "novita"
    },
    "novita/qwen/qwen3-omni-30b-a3b-thinking": {
      "inputUsdPerMillion": 0.25,
      "outputUsdPerMillion": 0.9700000000000001,
      "provider": "novita"
    },
    "novita/qwen/qwen3-omni-30b-a3b-instruct": {
      "inputUsdPerMillion": 0.25,
      "outputUsdPerMillion": 0.9700000000000001,
      "provider": "novita"
    },
    "novita/qwen/qwen-mt-plus": {
      "inputUsdPerMillion": 0.25,
      "outputUsdPerMillion": 0.75,
      "provider": "novita"
    },
    "novita/baidu/ernie-4.5-vl-28b-a3b": {
      "inputUsdPerMillion": 0.14,
      "outputUsdPerMillion": 0.56,
      "provider": "novita"
    },
    "novita/baidu/ernie-4.5-21B-a3b": {
      "inputUsdPerMillion": 0.07,
      "outputUsdPerMillion": 0.28,
      "provider": "novita"
    },
    "novita/qwen/qwen3-8b-fp8": {
      "inputUsdPerMillion": 0.035,
      "outputUsdPerMillion": 0.13799999999999998,
      "provider": "novita"
    },
    "novita/qwen/qwen3-4b-fp8": {
      "inputUsdPerMillion": 0.03,
      "outputUsdPerMillion": 0.03,
      "provider": "novita"
    },
    "novita/qwen/qwen2.5-7b-instruct": {
      "inputUsdPerMillion": 0.07,
      "outputUsdPerMillion": 0.07,
      "provider": "novita"
    },
    "novita/meta-llama/llama-3.2-3b-instruct": {
      "inputUsdPerMillion": 0.03,
      "outputUsdPerMillion": 0.049999999999999996,
      "provider": "novita"
    },
    "novita/sao10k/l31-70b-euryale-v2.2": {
      "inputUsdPerMillion": 1.48,
      "outputUsdPerMillion": 1.48,
      "provider": "novita"
    },
    "llamagate/llama-3.1-8b": {
      "inputUsdPerMillion": 0.03,
      "outputUsdPerMillion": 0.049999999999999996,
      "provider": "llamagate"
    },
    "llamagate/llama-3.2-3b": {
      "inputUsdPerMillion": 0.04,
      "outputUsdPerMillion": 0.08,
      "provider": "llamagate"
    },
    "llamagate/mistral-7b-v0.3": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.15,
      "provider": "llamagate"
    },
    "llamagate/qwen3-8b": {
      "inputUsdPerMillion": 0.04,
      "outputUsdPerMillion": 0.14,
      "provider": "llamagate"
    },
    "llamagate/dolphin3-8b": {
      "inputUsdPerMillion": 0.08,
      "outputUsdPerMillion": 0.15,
      "provider": "llamagate"
    },
    "llamagate/deepseek-r1-8b": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "llamagate"
    },
    "llamagate/deepseek-r1-7b-qwen": {
      "inputUsdPerMillion": 0.08,
      "outputUsdPerMillion": 0.15,
      "provider": "llamagate"
    },
    "llamagate/openthinker-7b": {
      "inputUsdPerMillion": 0.08,
      "outputUsdPerMillion": 0.15,
      "provider": "llamagate"
    },
    "llamagate/qwen2.5-coder-7b": {
      "inputUsdPerMillion": 0.06,
      "outputUsdPerMillion": 0.12,
      "provider": "llamagate"
    },
    "llamagate/deepseek-coder-6.7b": {
      "inputUsdPerMillion": 0.06,
      "outputUsdPerMillion": 0.12,
      "provider": "llamagate"
    },
    "llamagate/codellama-7b": {
      "inputUsdPerMillion": 0.06,
      "outputUsdPerMillion": 0.12,
      "provider": "llamagate"
    },
    "llamagate/qwen3-vl-8b": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.55,
      "provider": "llamagate"
    },
    "llamagate/llava-7b": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "llamagate"
    },
    "llamagate/gemma3-4b": {
      "inputUsdPerMillion": 0.03,
      "outputUsdPerMillion": 0.08,
      "provider": "llamagate"
    },
    "libertai/hermes-3-8b-tee": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.6,
      "provider": "libertai",
      "sourceUrl": "https://docs.libertai.io/apis/text/"
    },
    "libertai/gemma-4-31b-it": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.39999999999999997,
      "provider": "libertai",
      "sourceUrl": "https://docs.libertai.io/apis/text/"
    },
    "libertai/gemma-4-31b-it-thinking": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.39999999999999997,
      "provider": "libertai",
      "sourceUrl": "https://docs.libertai.io/apis/text/"
    },
    "libertai/qwen3.6-27b": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.5,
      "provider": "libertai",
      "sourceUrl": "https://docs.libertai.io/apis/text/"
    },
    "libertai/qwen3.6-27b-thinking": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.5,
      "provider": "libertai",
      "sourceUrl": "https://docs.libertai.io/apis/text/"
    },
    "libertai/qwen3.6-35b-a3b": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.5,
      "provider": "libertai",
      "sourceUrl": "https://docs.libertai.io/apis/text/"
    },
    "libertai/qwen3.6-35b-a3b-thinking": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.5,
      "provider": "libertai",
      "sourceUrl": "https://docs.libertai.io/apis/text/"
    },
    "libertai/qwen3.5-122b-a10b": {
      "inputUsdPerMillion": 0.25,
      "outputUsdPerMillion": 1.75,
      "provider": "libertai",
      "sourceUrl": "https://docs.libertai.io/apis/text/"
    },
    "libertai/qwen3.5-122b-a10b-thinking": {
      "inputUsdPerMillion": 0.25,
      "outputUsdPerMillion": 1.75,
      "provider": "libertai",
      "sourceUrl": "https://docs.libertai.io/apis/text/"
    },
    "libertai/deepseek-v4-flash": {
      "inputUsdPerMillion": 0.25,
      "outputUsdPerMillion": 1.75,
      "provider": "libertai",
      "sourceUrl": "https://docs.libertai.io/apis/text/"
    },
    "libertai/deepseek-v4-flash-thinking": {
      "inputUsdPerMillion": 0.25,
      "outputUsdPerMillion": 1.75,
      "provider": "libertai",
      "sourceUrl": "https://docs.libertai.io/apis/text/"
    },
    "sarvam/sarvam-m": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "cacheReadUsdPerMillion": 0,
      "cacheWriteUsdPerMillion": 0,
      "provider": "sarvam"
    },
    "gpt-5-search-api": {
      "inputUsdPerMillion": 1.25,
      "outputUsdPerMillion": 10,
      "cacheReadUsdPerMillion": 0.125,
      "provider": "openai",
      "sourceUrl": "https://developers.openai.com/api/docs/pricing"
    },
    "gpt-5-search-api-2025-10-14": {
      "inputUsdPerMillion": 1.25,
      "outputUsdPerMillion": 10,
      "cacheReadUsdPerMillion": 0.125,
      "provider": "openai",
      "sourceUrl": "https://developers.openai.com/api/docs/pricing"
    },
    "gemini-flash-latest": {
      "inputUsdPerMillion": 0.75,
      "outputUsdPerMillion": 3.75,
      "cacheReadUsdPerMillion": 0.075,
      "reasoningUsdPerMillion": 3.75,
      "provider": "gemini",
      "sourceUrl": "https://ai.google.dev/gemini-api/docs/pricing"
    },
    "gemini-flash-lite-latest": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 2.5,
      "cacheReadUsdPerMillion": 0.03,
      "reasoningUsdPerMillion": 2.5,
      "provider": "gemini",
      "sourceUrl": "https://ai.google.dev/gemini-api/docs/pricing"
    },
    "gemini-pro-latest": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 12,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "provider": "gemini",
      "sourceUrl": "https://ai.google.dev/gemini-api/docs/pricing"
    },
    "gemini/gemini-pro-latest": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 12,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "provider": "gemini",
      "sourceUrl": "https://ai.google.dev/gemini-api/docs/pricing"
    },
    "gemini-exp-1206": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 2.5,
      "cacheReadUsdPerMillion": 0.03,
      "reasoningUsdPerMillion": 2.5,
      "provider": "gemini",
      "sourceUrl": "https://ai.google.dev/gemini-api/docs/models#gemini-2.5-flash-preview"
    },
    "vertex_ai/claude-sonnet-5@default": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 10,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "cacheWriteUsdPerMillion": 2.5,
      "provider": "vertex_ai-anthropic_models",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "vertex_ai/claude-sonnet-4-6@default": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 15,
      "cacheReadUsdPerMillion": 0.3,
      "cacheWriteUsdPerMillion": 3.75,
      "provider": "vertex_ai-anthropic_models",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "bedrock_mantle/openai.gpt-oss-120b": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.6,
      "provider": "bedrock_mantle",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-oss-120b.html"
    },
    "bedrock_mantle/openai.gpt-oss-20b": {
      "inputUsdPerMillion": 0.07,
      "outputUsdPerMillion": 0.3,
      "provider": "bedrock_mantle",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-oss-20b.html"
    },
    "bedrock_mantle/openai.gpt-oss-safeguard-120b": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.6,
      "provider": "bedrock_mantle",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-oss-safeguard-120b.html"
    },
    "bedrock_mantle/openai.gpt-oss-safeguard-20b": {
      "inputUsdPerMillion": 0.07,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "bedrock_mantle",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-oss-safeguard-20b.html"
    },
    "us.openai.gpt-5.6-sol": {
      "inputUsdPerMillion": 4.4,
      "outputUsdPerMillion": 22,
      "cacheReadUsdPerMillion": 0.44,
      "cacheWriteUsdPerMillion": 5.5,
      "provider": "bedrock_converse",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-56-sol.html"
    },
    "global.openai.gpt-5.6-sol": {
      "inputUsdPerMillion": 4,
      "outputUsdPerMillion": 20,
      "cacheReadUsdPerMillion": 0.39999999999999997,
      "cacheWriteUsdPerMillion": 5,
      "provider": "bedrock_converse",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-56-sol.html"
    },
    "us.openai.gpt-5.6-terra": {
      "inputUsdPerMillion": 2.2,
      "outputUsdPerMillion": 13.200000000000001,
      "cacheReadUsdPerMillion": 0.22,
      "cacheWriteUsdPerMillion": 2.75,
      "provider": "bedrock_converse",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-56-terra.html"
    },
    "global.openai.gpt-5.6-terra": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 12,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "cacheWriteUsdPerMillion": 2.5,
      "provider": "bedrock_converse",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-56-terra.html"
    },
    "us.openai.gpt-5.6-luna": {
      "inputUsdPerMillion": 0.22,
      "outputUsdPerMillion": 1.32,
      "cacheReadUsdPerMillion": 0.022,
      "cacheWriteUsdPerMillion": 0.275,
      "provider": "bedrock_converse",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-56-luna.html"
    },
    "us.openai.gpt-5.4": {
      "inputUsdPerMillion": 2.75,
      "outputUsdPerMillion": 16.5,
      "cacheReadUsdPerMillion": 0.275,
      "provider": "bedrock_converse",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-54.html"
    },
    "global.openai.gpt-5.4": {
      "inputUsdPerMillion": 2.5,
      "outputUsdPerMillion": 15,
      "cacheReadUsdPerMillion": 0.25,
      "provider": "bedrock_converse",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-54.html"
    },
    "us.openai.gpt-5.5": {
      "inputUsdPerMillion": 5.5,
      "outputUsdPerMillion": 33,
      "cacheReadUsdPerMillion": 0.55,
      "provider": "bedrock_converse",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-55.html"
    },
    "global.openai.gpt-5.5": {
      "inputUsdPerMillion": 5,
      "outputUsdPerMillion": 30,
      "cacheReadUsdPerMillion": 0.5,
      "provider": "bedrock_converse",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-55.html"
    },
    "global.openai.gpt-5.6-luna": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 1.2,
      "cacheReadUsdPerMillion": 0.02,
      "cacheWriteUsdPerMillion": 0.25,
      "provider": "bedrock_converse",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-56-luna.html"
    },
    "us.openai.gpt-6-astra": {
      "inputUsdPerMillion": 11,
      "outputUsdPerMillion": 55,
      "cacheReadUsdPerMillion": 1.1,
      "cacheWriteUsdPerMillion": 13.75,
      "provider": "bedrock_converse",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-6-astra.html"
    },
    "us.openai.gpt-6-sol": {
      "inputUsdPerMillion": 2.2,
      "outputUsdPerMillion": 11,
      "cacheReadUsdPerMillion": 0.22,
      "cacheWriteUsdPerMillion": 2.75,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "us.openai.gpt-6-luna": {
      "inputUsdPerMillion": 0.11,
      "outputUsdPerMillion": 0.55,
      "cacheReadUsdPerMillion": 0.011,
      "cacheWriteUsdPerMillion": 0.1375,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "global.openai.gpt-6-astra": {
      "inputUsdPerMillion": 10,
      "outputUsdPerMillion": 50,
      "cacheReadUsdPerMillion": 1,
      "cacheWriteUsdPerMillion": 12.5,
      "provider": "bedrock_converse",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-6-astra.html"
    },
    "openai.gpt-6-sol": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 10,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "cacheWriteUsdPerMillion": 2.5,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "global.openai.gpt-6-sol": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 10,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "cacheWriteUsdPerMillion": 2.5,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "openai.gpt-6-luna": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.5,
      "cacheReadUsdPerMillion": 0.01,
      "cacheWriteUsdPerMillion": 0.125,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "global.openai.gpt-6-luna": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.5,
      "cacheReadUsdPerMillion": 0.01,
      "cacheWriteUsdPerMillion": 0.125,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "bedrock_mantle/google.gemma-4-31b": {
      "inputUsdPerMillion": 0.14,
      "outputUsdPerMillion": 0.39999999999999997,
      "provider": "bedrock_mantle"
    },
    "bedrock_mantle/google.gemma-4-26b-a4b": {
      "inputUsdPerMillion": 0.13,
      "outputUsdPerMillion": 0.39999999999999997,
      "provider": "bedrock_mantle"
    },
    "bedrock_mantle/google.gemma-4-e2b": {
      "inputUsdPerMillion": 0.04,
      "outputUsdPerMillion": 0.08,
      "provider": "bedrock_mantle"
    },
    "bedrock_mantle/xai.grok-4.3": {
      "inputUsdPerMillion": 1.25,
      "outputUsdPerMillion": 2.5,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "provider": "bedrock_mantle",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "bedrock_mantle/xai.grok-4.6": {
      "inputUsdPerMillion": 2.2,
      "outputUsdPerMillion": 6.6000000000000005,
      "cacheReadUsdPerMillion": 0.55,
      "provider": "bedrock_mantle",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-xai-grok-4-6.html"
    },
    "bedrock_mantle/anthropic.claude-haiku-4-5": {
      "inputUsdPerMillion": 1,
      "outputUsdPerMillion": 5,
      "cacheReadUsdPerMillion": 0.09999999999999999,
      "cacheWriteUsdPerMillion": 1.25,
      "provider": "bedrock_mantle",
      "sourceUrl": "https://aws.amazon.com/about-aws/whats-new/2025/10/claude-4-5-haiku-anthropic-amazon-bedrock"
    },
    "bedrock_mantle/anthropic.claude-opus-5-5": {
      "inputUsdPerMillion": 4.4,
      "outputUsdPerMillion": 22,
      "cacheReadUsdPerMillion": 0.22,
      "cacheWriteUsdPerMillion": 5.5,
      "provider": "bedrock_mantle",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-opus-5-5.html"
    },
    "bedrock_mantle/anthropic.claude-sonnet-5-5": {
      "inputUsdPerMillion": 2.2,
      "outputUsdPerMillion": 11,
      "cacheReadUsdPerMillion": 0.11,
      "cacheWriteUsdPerMillion": 2.75,
      "provider": "bedrock_mantle",
      "sourceUrl": "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrockFoundationModels/current/index.json"
    },
    "us.xai.grok-4.6": {
      "inputUsdPerMillion": 2.2,
      "outputUsdPerMillion": 6.6000000000000005,
      "cacheReadUsdPerMillion": 0.55,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "global.xai.grok-4.6": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 6,
      "cacheReadUsdPerMillion": 0.5,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "volcengine/doubao-seed-2-1-pro-260628": {
      "inputUsdPerMillion": 0.8625,
      "outputUsdPerMillion": 4.3125,
      "cacheReadUsdPerMillion": 0.1725,
      "provider": "volcengine",
      "sourceUrl": "https://www.volcengine.com/docs/82379/1544106"
    },
    "volcengine/doubao-seed-2-1-turbo-260628": {
      "inputUsdPerMillion": 0.43125,
      "outputUsdPerMillion": 2.15625,
      "cacheReadUsdPerMillion": 0.08625,
      "provider": "volcengine",
      "sourceUrl": "https://www.volcengine.com/docs/82379/1544106"
    },
    "bedrock/us-east-1/zai.glm-5": {
      "inputUsdPerMillion": 1,
      "outputUsdPerMillion": 3.1999999999999997,
      "provider": "bedrock",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "bedrock/us-west-2/zai.glm-5": {
      "inputUsdPerMillion": 1,
      "outputUsdPerMillion": 3.1999999999999997,
      "provider": "bedrock",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "bedrock/us-gov-east-1/anthropic.claude-haiku-4-5-20251001-v1:0": {
      "inputUsdPerMillion": 1.2,
      "outputUsdPerMillion": 6,
      "cacheReadUsdPerMillion": 0.12,
      "cacheWriteUsdPerMillion": 1.5,
      "provider": "bedrock",
      "sourceUrl": "https://aws.amazon.com/about-aws/whats-new/2025/10/claude-4-5-haiku-anthropic-amazon-bedrock"
    },
    "bedrock/us-gov-west-1/anthropic.claude-haiku-4-5-20251001-v1:0": {
      "inputUsdPerMillion": 1.2,
      "outputUsdPerMillion": 6,
      "cacheReadUsdPerMillion": 0.12,
      "cacheWriteUsdPerMillion": 1.5,
      "provider": "bedrock",
      "sourceUrl": "https://aws.amazon.com/about-aws/whats-new/2025/10/claude-4-5-haiku-anthropic-amazon-bedrock"
    },
    "snowflake/claude-sonnet-4-5": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 15,
      "cacheReadUsdPerMillion": 0.3,
      "provider": "snowflake"
    },
    "snowflake/claude-sonnet-4-6": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 15,
      "cacheReadUsdPerMillion": 0.3,
      "provider": "snowflake"
    },
    "snowflake/claude-4-sonnet": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 15,
      "cacheReadUsdPerMillion": 0.3,
      "provider": "snowflake"
    },
    "snowflake/claude-4-opus": {
      "inputUsdPerMillion": 5,
      "outputUsdPerMillion": 25,
      "cacheReadUsdPerMillion": 0.5,
      "provider": "snowflake"
    },
    "snowflake/claude-haiku-4-5": {
      "inputUsdPerMillion": 1,
      "outputUsdPerMillion": 5,
      "cacheReadUsdPerMillion": 0.09999999999999999,
      "provider": "snowflake"
    },
    "snowflake/claude-3-7-sonnet": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 15,
      "cacheReadUsdPerMillion": 0.3,
      "provider": "snowflake"
    },
    "snowflake/openai-gpt-4.1": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 8,
      "cacheReadUsdPerMillion": 0.5,
      "provider": "snowflake"
    },
    "snowflake/openai-gpt-5": {
      "inputUsdPerMillion": 1.25,
      "outputUsdPerMillion": 10,
      "cacheReadUsdPerMillion": 0.125,
      "provider": "snowflake"
    },
    "snowflake/openai-gpt-5-mini": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 1.2,
      "provider": "snowflake"
    },
    "snowflake/openai-gpt-5-nano": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.6,
      "provider": "snowflake"
    },
    "snowflake/llama4-maverick": {
      "inputUsdPerMillion": 0.24,
      "outputUsdPerMillion": 0.9700000000000001,
      "provider": "snowflake"
    },
    "tensormesh/Qwen/Qwen3.5-397B-A17B-FP8": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 3.5999999999999996,
      "cacheReadUsdPerMillion": 0,
      "provider": "tensormesh",
      "sourceUrl": "https://serverless.tensormesh.ai/v1/models/openrouter"
    },
    "tensormesh/Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8": {
      "inputUsdPerMillion": 0.44999999999999996,
      "outputUsdPerMillion": 1.7999999999999998,
      "cacheReadUsdPerMillion": 0,
      "provider": "tensormesh",
      "sourceUrl": "https://serverless.tensormesh.ai/v1/models/openrouter"
    },
    "tensormesh/Qwen/Qwen3.6-27B-FP8": {
      "inputUsdPerMillion": 0.32,
      "outputUsdPerMillion": 3.1999999999999997,
      "cacheReadUsdPerMillion": 0,
      "provider": "tensormesh",
      "sourceUrl": "https://serverless.tensormesh.ai/v1/models/openrouter"
    },
    "tensormesh/lukealonso/GLM-5.1-NVFP4-MTP": {
      "inputUsdPerMillion": 1.4,
      "outputUsdPerMillion": 4.4,
      "cacheReadUsdPerMillion": 0,
      "provider": "tensormesh",
      "sourceUrl": "https://serverless.tensormesh.ai/v1/models/openrouter"
    },
    "tensormesh/deepseek-ai/DeepSeek-V4-Flash": {
      "inputUsdPerMillion": 0.14,
      "outputUsdPerMillion": 0.28,
      "cacheReadUsdPerMillion": 0,
      "provider": "tensormesh",
      "sourceUrl": "https://serverless.tensormesh.ai/v1/models/openrouter"
    },
    "tensormesh/moonshotai/Kimi-K2.6": {
      "inputUsdPerMillion": 0.96,
      "outputUsdPerMillion": 4,
      "cacheReadUsdPerMillion": 0,
      "provider": "tensormesh",
      "sourceUrl": "https://serverless.tensormesh.ai/v1/models/openrouter"
    },
    "tensormesh/MiniMaxAI/MiniMax-M2.5": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 1.2,
      "cacheReadUsdPerMillion": 0,
      "provider": "tensormesh",
      "sourceUrl": "https://serverless.tensormesh.ai/v1/models/openrouter"
    },
    "tensormesh/google/gemma-4-31B-it": {
      "inputUsdPerMillion": 0.14,
      "outputUsdPerMillion": 0.56,
      "cacheReadUsdPerMillion": 0,
      "provider": "tensormesh",
      "sourceUrl": "https://serverless.tensormesh.ai/v1/models/openrouter"
    },
    "tensormesh/openai/gpt-oss-120b": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.6,
      "cacheReadUsdPerMillion": 0,
      "provider": "tensormesh",
      "sourceUrl": "https://serverless.tensormesh.ai/v1/models/openrouter"
    },
    "tensormesh/openai/gpt-oss-20b": {
      "inputUsdPerMillion": 0.07,
      "outputUsdPerMillion": 0.28,
      "cacheReadUsdPerMillion": 0,
      "provider": "tensormesh",
      "sourceUrl": "https://serverless.tensormesh.ai/v1/models/openrouter"
    },
    "deepseek-flash": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 1.2,
      "cacheReadUsdPerMillion": 0.006,
      "cacheWriteUsdPerMillion": 0,
      "provider": "deepseek",
      "sourceUrl": "https://api-docs.deepseek.com/quick_start/pricing"
    },
    "deepseek-v4-flash": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 1.2,
      "cacheReadUsdPerMillion": 0.006,
      "cacheWriteUsdPerMillion": 0,
      "provider": "deepseek",
      "sourceUrl": "https://api-docs.deepseek.com/quick_start/pricing"
    },
    "deepseek-v4-flash-vision-exp": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 1.2,
      "cacheReadUsdPerMillion": 0.006,
      "cacheWriteUsdPerMillion": 0,
      "provider": "deepseek",
      "sourceUrl": "https://api-docs.deepseek.com/quick_start/pricing"
    },
    "deepseek-v4-pro": {
      "inputUsdPerMillion": 1.32,
      "outputUsdPerMillion": 3.9600000000000004,
      "cacheReadUsdPerMillion": 0.044,
      "cacheWriteUsdPerMillion": 0,
      "provider": "deepseek",
      "sourceUrl": "https://api-docs.deepseek.com/quick_start/pricing"
    },
    "deepseek/deepseek-flash": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 1.2,
      "cacheReadUsdPerMillion": 0.006,
      "cacheWriteUsdPerMillion": 0,
      "provider": "deepseek",
      "sourceUrl": "https://api-docs.deepseek.com/quick_start/pricing"
    },
    "deepseek/deepseek-v4-flash": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 1.2,
      "cacheReadUsdPerMillion": 0.006,
      "cacheWriteUsdPerMillion": 0,
      "provider": "deepseek",
      "sourceUrl": "https://api-docs.deepseek.com/quick_start/pricing"
    },
    "deepseek/deepseek-v4-flash-vision-exp": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 1.2,
      "cacheReadUsdPerMillion": 0.006,
      "cacheWriteUsdPerMillion": 0,
      "provider": "deepseek",
      "sourceUrl": "https://api-docs.deepseek.com/quick_start/pricing"
    },
    "deepseek/deepseek-v4-pro": {
      "inputUsdPerMillion": 1.32,
      "outputUsdPerMillion": 3.9600000000000004,
      "cacheReadUsdPerMillion": 0.044,
      "cacheWriteUsdPerMillion": 0,
      "provider": "deepseek",
      "sourceUrl": "https://api-docs.deepseek.com/quick_start/pricing"
    },
    "tencent/deepseek-v4-pro": {
      "inputUsdPerMillion": 0.435,
      "outputUsdPerMillion": 0.87,
      "cacheReadUsdPerMillion": 0.003625,
      "cacheWriteUsdPerMillion": 0,
      "provider": "tencent",
      "sourceUrl": "https://www.tencentcloud.com/products/tokenhub"
    },
    "tencent/deepseek-v4-flash": {
      "inputUsdPerMillion": 0.14,
      "outputUsdPerMillion": 0.28,
      "cacheReadUsdPerMillion": 0.0028,
      "cacheWriteUsdPerMillion": 0,
      "provider": "tencent",
      "sourceUrl": "https://www.tencentcloud.com/products/tokenhub"
    },
    "tencent/minimax-m3": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 1.2,
      "cacheReadUsdPerMillion": 0.06,
      "cacheWriteUsdPerMillion": 0,
      "provider": "tencent",
      "sourceUrl": "https://www.tencentcloud.com/products/tokenhub"
    },
    "cognition/swe-1.6": {
      "inputUsdPerMillion": 0.5,
      "outputUsdPerMillion": 2.5,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "provider": "cognition",
      "sourceUrl": "https://docs.devin.ai/windsurf/plugins/cascade/models"
    },
    "cognition/swe-1.7": {
      "inputUsdPerMillion": 0.5,
      "outputUsdPerMillion": 2.5,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "provider": "cognition",
      "sourceUrl": "https://docs.devin.ai/desktop/models"
    },
    "cognition/swe-1.7-lightning": {
      "inputUsdPerMillion": 2.5,
      "outputUsdPerMillion": 12.5,
      "cacheReadUsdPerMillion": 1,
      "provider": "cognition",
      "sourceUrl": "https://docs.devin.ai/desktop/models"
    },
    "pinstripes/ps/glm-4.5-air": {
      "inputUsdPerMillion": 0.125,
      "outputUsdPerMillion": 0.44999999999999996,
      "provider": "pinstripes",
      "sourceUrl": "https://pinstripes.io/"
    },
    "pinstripes/ps/qwen3.6-35b-a3b": {
      "inputUsdPerMillion": 0.14,
      "outputUsdPerMillion": 0.44999999999999996,
      "provider": "pinstripes",
      "sourceUrl": "https://pinstripes.io/"
    },
    "pinstripes/ps/qwen3-30b-a3b": {
      "inputUsdPerMillion": 0.09,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "pinstripes",
      "sourceUrl": "https://pinstripes.io/"
    },
    "pinstripes/ps/qwen3-coder-30b-a3b": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 0.6,
      "provider": "pinstripes",
      "sourceUrl": "https://pinstripes.io/"
    },
    "pinstripes/ps/deepseek-v4-flash": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "pinstripes",
      "sourceUrl": "https://pinstripes.io/"
    },
    "pinstripes/ps/minimax-m2.7": {
      "inputUsdPerMillion": 0.255,
      "outputUsdPerMillion": 0.55,
      "provider": "pinstripes",
      "sourceUrl": "https://pinstripes.io/"
    },
    "darkbloom/gemma-4-26b": {
      "inputUsdPerMillion": 0.03,
      "outputUsdPerMillion": 0.165,
      "provider": "darkbloom",
      "sourceUrl": "https://www.darkbloom.dev/"
    },
    "darkbloom/gpt-oss-20b": {
      "inputUsdPerMillion": 0.0145,
      "outputUsdPerMillion": 0.07,
      "provider": "darkbloom",
      "sourceUrl": "https://www.darkbloom.dev/"
    },
    "xai/grok-4.20-0309-non-reasoning": {
      "inputUsdPerMillion": 1.25,
      "outputUsdPerMillion": 2.5,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "provider": "xai",
      "sourceUrl": "https://api.x.ai/v1/language-models"
    },
    "xai/grok-build-0.1": {
      "inputUsdPerMillion": 1,
      "outputUsdPerMillion": 2,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "provider": "xai",
      "sourceUrl": "https://api.x.ai/v1/language-models"
    },
    "claude-mythos-5": {
      "inputUsdPerMillion": 10,
      "outputUsdPerMillion": 50,
      "cacheReadUsdPerMillion": 1,
      "cacheWriteUsdPerMillion": 12.5,
      "provider": "anthropic",
      "sourceUrl": "https://platform.claude.com/docs/en/about-claude/pricing"
    },
    "claude-mythos-5-1": {
      "inputUsdPerMillion": 10,
      "outputUsdPerMillion": 50,
      "cacheReadUsdPerMillion": 0.25,
      "cacheWriteUsdPerMillion": 12.5,
      "provider": "anthropic",
      "sourceUrl": "https://platform.claude.com/docs/en/about-claude/pricing"
    },
    "claude-mythos-preview": {
      "inputUsdPerMillion": 10,
      "outputUsdPerMillion": 50,
      "cacheReadUsdPerMillion": 1,
      "cacheWriteUsdPerMillion": 12.5,
      "provider": "anthropic",
      "sourceUrl": "https://platform.claude.com/docs/en/about-claude/models/overview"
    },
    "gemini/gemini-robotics-er-2-streaming-preview": {
      "inputUsdPerMillion": 1,
      "outputUsdPerMillion": 5,
      "provider": "gemini",
      "sourceUrl": "https://ai.google.dev/gemini-api/docs/pricing"
    },
    "mistral/mistral-small-2603": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.6,
      "cacheReadUsdPerMillion": 0.015,
      "provider": "mistral",
      "sourceUrl": "https://docs.mistral.ai/models/model-cards/mistral-small-4-0-26-03"
    },
    "mistral/labs-leanstral-1-5": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "mistral",
      "sourceUrl": "https://docs.mistral.ai/models/model-cards/leanstral-1-5"
    },
    "fireworks_ai/accounts/fireworks/models/deepseek-v4-flash-0731": {
      "inputUsdPerMillion": 0.22,
      "outputUsdPerMillion": 0.66,
      "cacheReadUsdPerMillion": 0.007,
      "provider": "fireworks_ai",
      "sourceUrl": "https://api.fireworks.ai/v1/serverless/models"
    },
    "fireworks_ai/accounts/fireworks/models/deepseek-v4p1-flash": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 1.2,
      "cacheReadUsdPerMillion": 0.006,
      "provider": "fireworks_ai",
      "sourceUrl": "https://docs.fireworks.ai/serverless/pricing"
    },
    "fireworks_ai/accounts/fireworks/routers/deepseek-v4p1-flash-us": {
      "inputUsdPerMillion": 0.44999999999999996,
      "outputUsdPerMillion": 1.7999999999999998,
      "cacheReadUsdPerMillion": 0.009,
      "provider": "fireworks_ai",
      "sourceUrl": "https://docs.fireworks.ai/serverless/pricing"
    },
    "fireworks_ai/accounts/fireworks/models/deepseek-v4-flash-vision-exp": {
      "inputUsdPerMillion": 0.22,
      "outputUsdPerMillion": 0.66,
      "cacheReadUsdPerMillion": 0.007,
      "provider": "fireworks_ai",
      "sourceUrl": "https://api.fireworks.ai/v1/serverless/models"
    },
    "fireworks_ai/accounts/fireworks/models/kimi-k3": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 15,
      "cacheReadUsdPerMillion": 0.3,
      "provider": "fireworks_ai",
      "sourceUrl": "https://api.fireworks.ai/v1/serverless/models"
    },
    "fireworks_ai/deepseek-v4-flash-0731": {
      "inputUsdPerMillion": 0.22,
      "outputUsdPerMillion": 0.66,
      "cacheReadUsdPerMillion": 0.007,
      "provider": "fireworks_ai",
      "sourceUrl": "https://api.fireworks.ai/v1/serverless/models"
    },
    "fireworks_ai/deepseek-v4p1-flash": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 1.2,
      "cacheReadUsdPerMillion": 0.006,
      "provider": "fireworks_ai",
      "sourceUrl": "https://docs.fireworks.ai/serverless/pricing"
    },
    "fireworks_ai/deepseek-v4p1-flash-us": {
      "inputUsdPerMillion": 0.44999999999999996,
      "outputUsdPerMillion": 1.7999999999999998,
      "cacheReadUsdPerMillion": 0.009,
      "provider": "fireworks_ai",
      "sourceUrl": "https://docs.fireworks.ai/serverless/pricing"
    },
    "fireworks_ai/deepseek-v4-flash-vision-exp": {
      "inputUsdPerMillion": 0.22,
      "outputUsdPerMillion": 0.66,
      "cacheReadUsdPerMillion": 0.007,
      "provider": "fireworks_ai",
      "sourceUrl": "https://api.fireworks.ai/v1/serverless/models"
    },
    "fireworks_ai/glm-5p2-fast": {
      "inputUsdPerMillion": 2.0999999999999996,
      "outputUsdPerMillion": 6.6000000000000005,
      "cacheReadUsdPerMillion": 0.21,
      "provider": "fireworks_ai",
      "sourceUrl": "https://docs.fireworks.ai/serverless/pricing"
    },
    "fireworks_ai/glm-5p2-fast-us": {
      "inputUsdPerMillion": 2.0999999999999996,
      "outputUsdPerMillion": 6.6000000000000005,
      "cacheReadUsdPerMillion": 0.21,
      "provider": "fireworks_ai",
      "sourceUrl": "https://docs.fireworks.ai/serverless/pricing"
    },
    "fireworks_ai/kimi-k3": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 15,
      "cacheReadUsdPerMillion": 0.3,
      "provider": "fireworks_ai",
      "sourceUrl": "https://api.fireworks.ai/v1/serverless/models"
    },
    "fireworks_ai/kimi-k3-fast": {
      "inputUsdPerMillion": 4.5,
      "outputUsdPerMillion": 22.5,
      "cacheReadUsdPerMillion": 0.44999999999999996,
      "provider": "fireworks_ai",
      "sourceUrl": "https://docs.fireworks.ai/serverless/pricing"
    },
    "fireworks_ai/kimi-k3-us": {
      "inputUsdPerMillion": 4.5,
      "outputUsdPerMillion": 22.5,
      "cacheReadUsdPerMillion": 0.44999999999999996,
      "provider": "fireworks_ai",
      "sourceUrl": "https://docs.fireworks.ai/serverless/pricing"
    },
    "fireworks_ai/qwen3p8-max": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 6,
      "cacheReadUsdPerMillion": 0.25,
      "provider": "fireworks_ai",
      "sourceUrl": "https://api.fireworks.ai/v1/serverless/models"
    },
    "fireworks_ai/muse-glimmer-30b": {
      "inputUsdPerMillion": 0.35,
      "outputUsdPerMillion": 1.5,
      "cacheReadUsdPerMillion": 0.04,
      "provider": "fireworks_ai",
      "sourceUrl": "https://api.fireworks.ai/v1/serverless/models"
    },
    "fireworks_ai/nemotron-lightning-3p5-30b-a3b": {
      "inputUsdPerMillion": 0.049999999999999996,
      "outputUsdPerMillion": 0.19999999999999998,
      "cacheReadUsdPerMillion": 0.01,
      "provider": "fireworks_ai",
      "sourceUrl": "https://docs.fireworks.ai/serverless/pricing"
    },
    "fireworks_ai/nemotron-3-ultra-nvfp4": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 2.4,
      "cacheReadUsdPerMillion": 0.12,
      "provider": "fireworks_ai",
      "sourceUrl": "https://api.fireworks.ai/v1/serverless/models"
    },
    "fireworks_ai/accounts/fireworks/models/muse-glimmer-30b": {
      "inputUsdPerMillion": 0.35,
      "outputUsdPerMillion": 1.5,
      "cacheReadUsdPerMillion": 0.04,
      "provider": "fireworks_ai",
      "sourceUrl": "https://api.fireworks.ai/v1/serverless/models"
    },
    "fireworks_ai/accounts/fireworks/models/nemotron-lightning-3p5-30b-a3b": {
      "inputUsdPerMillion": 0.049999999999999996,
      "outputUsdPerMillion": 0.19999999999999998,
      "cacheReadUsdPerMillion": 0.01,
      "provider": "fireworks_ai",
      "sourceUrl": "https://docs.fireworks.ai/serverless/pricing"
    },
    "fireworks_ai/accounts/fireworks/models/nemotron-3-ultra-nvfp4": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 2.4,
      "cacheReadUsdPerMillion": 0.12,
      "provider": "fireworks_ai",
      "sourceUrl": "https://api.fireworks.ai/v1/serverless/models"
    },
    "fireworks_ai/accounts/fireworks/models/qwen3p8-max": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 6,
      "cacheReadUsdPerMillion": 0.25,
      "provider": "fireworks_ai",
      "sourceUrl": "https://api.fireworks.ai/v1/serverless/models"
    },
    "fireworks_ai/accounts/fireworks/routers/glm-5p2-fast": {
      "inputUsdPerMillion": 2.0999999999999996,
      "outputUsdPerMillion": 6.6000000000000005,
      "cacheReadUsdPerMillion": 0.21,
      "provider": "fireworks_ai",
      "sourceUrl": "https://api.fireworks.ai/v1/serverless/models"
    },
    "fireworks_ai/accounts/fireworks/routers/glm-5p2-fast-us": {
      "inputUsdPerMillion": 2.0999999999999996,
      "outputUsdPerMillion": 6.6000000000000005,
      "cacheReadUsdPerMillion": 0.21,
      "provider": "fireworks_ai",
      "sourceUrl": "https://docs.fireworks.ai/serverless/pricing"
    },
    "fireworks_ai/accounts/fireworks/routers/kimi-k3-fast": {
      "inputUsdPerMillion": 4.5,
      "outputUsdPerMillion": 22.5,
      "cacheReadUsdPerMillion": 0.44999999999999996,
      "provider": "fireworks_ai",
      "sourceUrl": "https://api.fireworks.ai/v1/serverless/models"
    },
    "fireworks_ai/accounts/fireworks/routers/kimi-k3-us": {
      "inputUsdPerMillion": 4.5,
      "outputUsdPerMillion": 22.5,
      "cacheReadUsdPerMillion": 0.44999999999999996,
      "provider": "fireworks_ai",
      "sourceUrl": "https://docs.fireworks.ai/serverless/pricing"
    },
    "novita/zai-org/glm-5.3": {
      "inputUsdPerMillion": 1.4,
      "outputUsdPerMillion": 4.4,
      "cacheReadUsdPerMillion": 0.26,
      "provider": "novita",
      "sourceUrl": "https://api.novita.ai/v3/openai/models"
    },
    "novita/deepseek/deepseek-v4-pro-0813": {
      "inputUsdPerMillion": 1.32,
      "outputUsdPerMillion": 3.9600000000000004,
      "cacheReadUsdPerMillion": 0.132,
      "provider": "novita",
      "sourceUrl": "https://novita.ai/pricing"
    },
    "novita/moonshotai/kimi-k3": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 15,
      "cacheReadUsdPerMillion": 0.3,
      "provider": "novita",
      "sourceUrl": "https://novita.ai/pricing"
    },
    "novita/tencent/hy3": {
      "inputUsdPerMillion": 0.14,
      "outputUsdPerMillion": 0.58,
      "cacheReadUsdPerMillion": 0.035,
      "provider": "novita",
      "sourceUrl": "https://novita.ai/pricing"
    },
    "novita/zai-org/glm-5.2": {
      "inputUsdPerMillion": 1.4,
      "outputUsdPerMillion": 4.4,
      "cacheReadUsdPerMillion": 0.26,
      "provider": "novita",
      "sourceUrl": "https://novita.ai/pricing"
    },
    "novita/moonshotai/kimi-k2.7-code": {
      "inputUsdPerMillion": 0.95,
      "outputUsdPerMillion": 4,
      "cacheReadUsdPerMillion": 0.19,
      "provider": "novita",
      "sourceUrl": "https://novita.ai/pricing"
    },
    "novita/deepseek/deepseek-v4-flash-vision-exp": {
      "inputUsdPerMillion": 0.44,
      "outputUsdPerMillion": 1.32,
      "cacheReadUsdPerMillion": 0.028,
      "provider": "novita",
      "sourceUrl": "https://api.novita.ai/v3/openai/models"
    },
    "novita/deepseek/deepseek-v4-flash-0731": {
      "inputUsdPerMillion": 0.44,
      "outputUsdPerMillion": 1.32,
      "cacheReadUsdPerMillion": 0.028,
      "provider": "novita",
      "sourceUrl": "https://novita.ai/pricing"
    },
    "novita/mindai/macaron-v1-venti": {
      "inputUsdPerMillion": 1.5,
      "outputUsdPerMillion": 4.5,
      "cacheReadUsdPerMillion": 0.3,
      "provider": "novita",
      "sourceUrl": "https://novita.ai/pricing"
    },
    "novita/minimax/minimax-m3": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 1.2,
      "cacheReadUsdPerMillion": 0.06,
      "provider": "novita",
      "sourceUrl": "https://novita.ai/pricing"
    },
    "novita/deepseek/deepseek-v4-flash": {
      "inputUsdPerMillion": 0.14,
      "outputUsdPerMillion": 0.28,
      "cacheReadUsdPerMillion": 0.028,
      "provider": "novita",
      "sourceUrl": "https://novita.ai/pricing"
    },
    "novita/deepseek/deepseek-v4-pro": {
      "inputUsdPerMillion": 1.6,
      "outputUsdPerMillion": 3.2,
      "cacheReadUsdPerMillion": 0.135,
      "provider": "novita",
      "sourceUrl": "https://novita.ai/pricing"
    },
    "novita/inclusionai/ling-3.0-flash-fast": {
      "inputUsdPerMillion": 0.06,
      "outputUsdPerMillion": 0.18,
      "cacheReadUsdPerMillion": 0.012,
      "provider": "novita",
      "sourceUrl": "https://novita.ai/pricing"
    },
    "novita/qwen/qwen3.8-max": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 6,
      "cacheReadUsdPerMillion": 0.25,
      "provider": "novita",
      "sourceUrl": "https://novita.ai/pricing"
    },
    "novita/inclusionai/ling-3.0-flash": {
      "inputUsdPerMillion": 0.06,
      "outputUsdPerMillion": 0.18,
      "cacheReadUsdPerMillion": 0.012,
      "provider": "novita",
      "sourceUrl": "https://novita.ai/pricing"
    },
    "novita/mindai/macaron-v1-tall": {
      "inputUsdPerMillion": 0.45,
      "outputUsdPerMillion": 2.6,
      "cacheReadUsdPerMillion": 0.08,
      "provider": "novita",
      "sourceUrl": "https://novita.ai/pricing"
    },
    "novita/stepfun/step-3.7-flash": {
      "inputUsdPerMillion": 0.2,
      "outputUsdPerMillion": 1.15,
      "cacheReadUsdPerMillion": 0.04,
      "provider": "novita",
      "sourceUrl": "https://novita.ai/pricing"
    },
    "novita/nvidia/nemotron-3-nano-30b-a3b": {
      "inputUsdPerMillion": 0.05,
      "outputUsdPerMillion": 0.2,
      "provider": "novita",
      "sourceUrl": "https://novita.ai/pricing"
    },
    "novita/baidu/cobuddy": {
      "inputUsdPerMillion": 0.28,
      "outputUsdPerMillion": 1.13,
      "cacheReadUsdPerMillion": 0.07,
      "provider": "novita",
      "sourceUrl": "https://novita.ai/pricing"
    },
    "novita/xiaomimimo/mimo-v2.5": {
      "inputUsdPerMillion": 0.168,
      "outputUsdPerMillion": 0.336,
      "cacheReadUsdPerMillion": 0.0034,
      "provider": "novita",
      "sourceUrl": "https://novita.ai/pricing"
    },
    "novita/qwen/qwen3.7-max": {
      "inputUsdPerMillion": 1.25,
      "outputUsdPerMillion": 3.75,
      "cacheReadUsdPerMillion": 0.25,
      "provider": "novita",
      "sourceUrl": "https://novita.ai/pricing"
    },
    "novita/xiaomimimo/mimo-v2.5-pro": {
      "inputUsdPerMillion": 0.522,
      "outputUsdPerMillion": 1.044,
      "cacheReadUsdPerMillion": 0.0043,
      "provider": "novita",
      "sourceUrl": "https://novita.ai/pricing"
    },
    "novita/qwen/qwen3.6-27b": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 3.6,
      "provider": "novita",
      "sourceUrl": "https://novita.ai/pricing"
    },
    "novita/moonshotai/kimi-k2.6": {
      "inputUsdPerMillion": 0.8,
      "outputUsdPerMillion": 3.4,
      "cacheReadUsdPerMillion": 0.16,
      "provider": "novita",
      "sourceUrl": "https://novita.ai/pricing"
    },
    "novita/zai-org/glm-5.1": {
      "inputUsdPerMillion": 1.38,
      "outputUsdPerMillion": 4.4,
      "cacheReadUsdPerMillion": 0.26,
      "provider": "novita",
      "sourceUrl": "https://novita.ai/pricing"
    },
    "novita/minimax/minimax-m2.7-highspeed": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 2.4,
      "cacheReadUsdPerMillion": 0.06,
      "provider": "novita",
      "sourceUrl": "https://api.novita.ai/v3/openai/models"
    },
    "novita/zai-org/glm-5v-turbo": {
      "inputUsdPerMillion": 1.2,
      "outputUsdPerMillion": 4,
      "cacheReadUsdPerMillion": 0.24,
      "provider": "novita",
      "sourceUrl": "https://api.novita.ai/v3/openai/models"
    },
    "novita/google/gemma-4-26b-a4b-it": {
      "inputUsdPerMillion": 0.13,
      "outputUsdPerMillion": 0.4,
      "provider": "novita",
      "sourceUrl": "https://novita.ai/pricing"
    },
    "novita/google/gemma-4-31b-it": {
      "inputUsdPerMillion": 0.14,
      "outputUsdPerMillion": 0.4,
      "provider": "novita",
      "sourceUrl": "https://novita.ai/pricing"
    },
    "novita/zai-org/glm-5-turbo": {
      "inputUsdPerMillion": 1.2,
      "outputUsdPerMillion": 4,
      "cacheReadUsdPerMillion": 0.24,
      "provider": "novita",
      "sourceUrl": "https://api.novita.ai/v3/openai/models"
    },
    "novita/minimax/minimax-m2.7": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 1.2,
      "cacheReadUsdPerMillion": 0.06,
      "provider": "novita",
      "sourceUrl": "https://novita.ai/pricing"
    },
    "novita/minimax/minimax-m2.5-highspeed": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 2.4,
      "cacheReadUsdPerMillion": 0.03,
      "provider": "novita",
      "sourceUrl": "https://novita.ai/pricing"
    },
    "novita/qwen/qwen3.5-27b": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 2.4,
      "provider": "novita",
      "sourceUrl": "https://novita.ai/pricing"
    },
    "novita/qwen/qwen3.5-122b-a10b": {
      "inputUsdPerMillion": 0.4,
      "outputUsdPerMillion": 3.2,
      "provider": "novita",
      "sourceUrl": "https://novita.ai/pricing"
    },
    "novita/qwen/qwen3.5-35b-a3b": {
      "inputUsdPerMillion": 0.25,
      "outputUsdPerMillion": 2,
      "provider": "novita",
      "sourceUrl": "https://novita.ai/pricing"
    },
    "novita/qwen/qwen3.5-397b-a17b": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 3.6,
      "provider": "novita",
      "sourceUrl": "https://novita.ai/pricing"
    },
    "novita/minimax/minimax-m2.5": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 1.2,
      "cacheReadUsdPerMillion": 0.03,
      "provider": "novita",
      "sourceUrl": "https://novita.ai/pricing"
    },
    "novita/zai-org/glm-5": {
      "inputUsdPerMillion": 1,
      "outputUsdPerMillion": 3.2,
      "cacheReadUsdPerMillion": 0.2,
      "provider": "novita",
      "sourceUrl": "https://novita.ai/pricing"
    },
    "novita/qwen/qwen3-coder-next": {
      "inputUsdPerMillion": 0.2,
      "outputUsdPerMillion": 1.5,
      "provider": "novita",
      "sourceUrl": "https://novita.ai/pricing"
    },
    "novita/deepseek/deepseek-ocr-2": {
      "inputUsdPerMillion": 0.03,
      "outputUsdPerMillion": 0.03,
      "provider": "novita",
      "sourceUrl": "https://novita.ai/pricing"
    },
    "novita/moonshotai/kimi-k2.5": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 3,
      "cacheReadUsdPerMillion": 0.1,
      "provider": "novita",
      "sourceUrl": "https://novita.ai/pricing"
    },
    "novita/zai-org/glm-4.7-h": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 2.2,
      "cacheReadUsdPerMillion": 0.11,
      "provider": "novita",
      "sourceUrl": "https://api.novita.ai/v3/openai/models"
    },
    "novita/zai-org/glm-4.7-flash": {
      "inputUsdPerMillion": 0.07,
      "outputUsdPerMillion": 0.4,
      "cacheReadUsdPerMillion": 0.01,
      "provider": "novita",
      "sourceUrl": "https://novita.ai/pricing"
    },
    "novita/qwen/qwen3.6-35b-a3b": {
      "inputUsdPerMillion": 0.248,
      "outputUsdPerMillion": 1.485,
      "provider": "novita",
      "sourceUrl": "https://novita.ai/pricing"
    },
    "novita/deepseek/deepseek_v3": {
      "inputUsdPerMillion": 0.89,
      "outputUsdPerMillion": 0.89,
      "provider": "novita",
      "sourceUrl": "https://api.novita.ai/v3/openai/models"
    },
    "novita/deepseek/deepseek-r1": {
      "inputUsdPerMillion": 4,
      "outputUsdPerMillion": 4,
      "provider": "novita",
      "sourceUrl": "https://api.novita.ai/v3/openai/models"
    },
    "novita/deepseek/deepseek-v3/community": {
      "inputUsdPerMillion": 0.89,
      "outputUsdPerMillion": 0.89,
      "provider": "novita",
      "sourceUrl": "https://api.novita.ai/v3/openai/models"
    },
    "novita/deepseek/deepseek-r1/community": {
      "inputUsdPerMillion": 4,
      "outputUsdPerMillion": 4,
      "provider": "novita",
      "sourceUrl": "https://api.novita.ai/v3/openai/models"
    },
    "novita/thudm/glm-4-32b-0414": {
      "inputUsdPerMillion": 0.55,
      "outputUsdPerMillion": 1.66,
      "provider": "novita",
      "sourceUrl": "https://api.novita.ai/v3/openai/models"
    },
    "novita/meta-llama/llama-3.2-1b-instruct": {
      "inputUsdPerMillion": 0.02,
      "outputUsdPerMillion": 0.02,
      "provider": "novita",
      "sourceUrl": "https://api.novita.ai/v3/openai/models"
    },
    "wandb/deepseek-ai/DeepSeek-V4-Flash": {
      "inputUsdPerMillion": 0.14,
      "outputUsdPerMillion": 0.28,
      "cacheReadUsdPerMillion": 0.07,
      "provider": "wandb",
      "sourceUrl": "https://wandb.ai/site/pricing/tokens/"
    },
    "wandb/deepseek-ai/DeepSeek-V4-Flash-0731": {
      "inputUsdPerMillion": 0.13,
      "outputUsdPerMillion": 0.28,
      "cacheReadUsdPerMillion": 0.07,
      "provider": "wandb",
      "sourceUrl": "https://wandb.ai/site/pricing/tokens/"
    },
    "wandb/deepseek-ai/DeepSeek-V4-Pro": {
      "inputUsdPerMillion": 1.15,
      "outputUsdPerMillion": 2.5500000000000003,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "provider": "wandb",
      "sourceUrl": "https://wandb.ai/site/pricing/tokens/"
    },
    "wandb/google/gemma-4-31B-it": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.33999999999999997,
      "provider": "wandb",
      "sourceUrl": "https://wandb.ai/site/pricing/tokens/"
    },
    "wandb/ibm-granite/granite-4.1-8b": {
      "inputUsdPerMillion": 0.049999999999999996,
      "outputUsdPerMillion": 0.09999999999999999,
      "provider": "wandb",
      "sourceUrl": "https://wandb.ai/site/pricing/tokens/"
    },
    "wandb/JetBrains/Mellum2-12B-A2.5B-Instruct": {
      "inputUsdPerMillion": 0.049999999999999996,
      "outputUsdPerMillion": 0.09999999999999999,
      "provider": "wandb",
      "sourceUrl": "https://wandb.ai/site/pricing/tokens/"
    },
    "wandb/meta-llama/Llama-3.1-70B-Instruct": {
      "inputUsdPerMillion": 0.7999999999999999,
      "outputUsdPerMillion": 0.7999999999999999,
      "provider": "wandb",
      "sourceUrl": "https://wandb.ai/site/pricing/tokens/"
    },
    "wandb/MiniMaxAI/MiniMax-M3": {
      "inputUsdPerMillion": 0.22999999999999998,
      "outputUsdPerMillion": 0.96,
      "cacheReadUsdPerMillion": 0.049999999999999996,
      "provider": "wandb",
      "sourceUrl": "https://wandb.ai/site/pricing/tokens/"
    },
    "wandb/moonshotai/Kimi-K2.7-Code": {
      "inputUsdPerMillion": 0.71,
      "outputUsdPerMillion": 3.5,
      "cacheReadUsdPerMillion": 0.15,
      "provider": "wandb",
      "sourceUrl": "https://wandb.ai/site/pricing/tokens/"
    },
    "wandb/moonshotai/Kimi-K2.6": {
      "inputUsdPerMillion": 0.65,
      "outputUsdPerMillion": 3.41,
      "cacheReadUsdPerMillion": 0.15,
      "provider": "wandb",
      "sourceUrl": "https://wandb.ai/site/pricing/tokens/"
    },
    "wandb/nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B": {
      "inputUsdPerMillion": 0.07,
      "outputUsdPerMillion": 0.19999999999999998,
      "cacheReadUsdPerMillion": 0.04,
      "provider": "wandb",
      "sourceUrl": "https://wandb.ai/site/pricing/tokens/"
    },
    "wandb/nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B": {
      "inputUsdPerMillion": 0.5,
      "outputUsdPerMillion": 2.1500000000000004,
      "cacheReadUsdPerMillion": 0.09999999999999999,
      "provider": "wandb",
      "sourceUrl": "https://wandb.ai/site/pricing/tokens/"
    },
    "wandb/OpenPipe/Qwen3-14B-Instruct": {
      "inputUsdPerMillion": 0.049999999999999996,
      "outputUsdPerMillion": 0.22,
      "provider": "wandb",
      "sourceUrl": "https://wandb.ai/site/pricing/tokens/"
    },
    "wandb/Qwen/Qwen3.8-27B": {
      "inputUsdPerMillion": 0.39999999999999997,
      "outputUsdPerMillion": 3,
      "cacheReadUsdPerMillion": 0.15,
      "provider": "wandb",
      "sourceUrl": "https://wandb.ai/site/pricing/tokens/"
    },
    "wandb/Qwen/Qwen3.6-35B-A3B": {
      "inputUsdPerMillion": 0.25,
      "outputUsdPerMillion": 1.25,
      "provider": "wandb",
      "sourceUrl": "https://wandb.ai/site/pricing/tokens/"
    },
    "wandb/Qwen/Qwen3.6-27B": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 3.5999999999999996,
      "cacheReadUsdPerMillion": 0.12,
      "provider": "wandb",
      "sourceUrl": "https://wandb.ai/site/pricing/tokens/"
    },
    "wandb/Qwen/Qwen3.5-35B-A3B": {
      "inputUsdPerMillion": 0.25,
      "outputUsdPerMillion": 1.25,
      "provider": "wandb",
      "sourceUrl": "https://wandb.ai/site/pricing/tokens/"
    },
    "wandb/Qwen/Qwen3-30B-A3B-Instruct-2507": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.3,
      "provider": "wandb",
      "sourceUrl": "https://wandb.ai/site/pricing/tokens/"
    },
    "wandb/deepseek-ai/DeepSeek-V4-Pro-0813": {
      "inputUsdPerMillion": 1.31,
      "outputUsdPerMillion": 3.9600000000000004,
      "cacheReadUsdPerMillion": 0.044,
      "provider": "wandb",
      "sourceUrl": "https://wandb.ai/site/pricing/tokens/"
    },
    "wandb/ibm-granite/granite-4.2-8b": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.15,
      "cacheReadUsdPerMillion": 0.049999999999999996,
      "provider": "wandb",
      "sourceUrl": "https://wandb.ai/site/pricing/tokens/"
    },
    "wandb/zai-org/GLM-5.2": {
      "inputUsdPerMillion": 0.76,
      "outputUsdPerMillion": 2.42,
      "cacheReadUsdPerMillion": 0.14,
      "provider": "wandb",
      "sourceUrl": "https://wandb.ai/site/pricing/tokens/"
    },
    "deepinfra/openai/gpt-oss-120b-Turbo": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.6,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/MiniMaxAI/MiniMax-M2.7": {
      "inputUsdPerMillion": 0.25,
      "outputUsdPerMillion": 1,
      "cacheReadUsdPerMillion": 0.049999999999999996,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/Qwen/Qwen3.8-27B": {
      "inputUsdPerMillion": 0.39999999999999997,
      "outputUsdPerMillion": 3,
      "cacheReadUsdPerMillion": 0.04,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/google/gemma-4-31B-it-Ultra": {
      "inputUsdPerMillion": 0.27,
      "outputUsdPerMillion": 0.76,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/moonshotai/Kimi-K2.5": {
      "inputUsdPerMillion": 0.44999999999999996,
      "outputUsdPerMillion": 2.25,
      "cacheReadUsdPerMillion": 0.07,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/zai-org/GLM-4.7-Flash": {
      "inputUsdPerMillion": 0.06,
      "outputUsdPerMillion": 0.39999999999999997,
      "cacheReadUsdPerMillion": 0.01,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/zai-org/GLM-4.6": {
      "inputUsdPerMillion": 0.5,
      "outputUsdPerMillion": 2,
      "cacheReadUsdPerMillion": 0.09999999999999999,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/anthropic/claude-opus-4-8": {
      "inputUsdPerMillion": 5,
      "outputUsdPerMillion": 25,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/anthropic/claude-sonnet-4-6": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 15,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/google/gemini-3.5-flash": {
      "inputUsdPerMillion": 1.5,
      "outputUsdPerMillion": 9,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/XiaomiMiMo/MiMo-V2.5": {
      "inputUsdPerMillion": 0.39999999999999997,
      "outputUsdPerMillion": 2,
      "cacheReadUsdPerMillion": 0.08,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/Qwen/Qwen3-Max": {
      "inputUsdPerMillion": 1.2,
      "outputUsdPerMillion": 6,
      "cacheReadUsdPerMillion": 0.24,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/google/gemma-4-31B-it-turbo": {
      "inputUsdPerMillion": 0.09,
      "outputUsdPerMillion": 0.33999999999999997,
      "cacheReadUsdPerMillion": 0.049999999999999996,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/thinkingmachines/Inkling-Small": {
      "inputUsdPerMillion": 0.44999999999999996,
      "outputUsdPerMillion": 1.2,
      "cacheReadUsdPerMillion": 0.09999999999999999,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/meta-models/Muse-Glimmer-30B": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 1.2,
      "cacheReadUsdPerMillion": 0.04,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/Qwen/Qwen3-Max-Thinking": {
      "inputUsdPerMillion": 1.2,
      "outputUsdPerMillion": 6,
      "cacheReadUsdPerMillion": 0.24,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/Qwen/Qwen3-VL-235B-A22B-Instruct": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.88,
      "cacheReadUsdPerMillion": 0.11,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/Qwen/Qwen3-VL-30B-A3B-Instruct": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.6,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/Qwen/Qwen3.5-27B": {
      "inputUsdPerMillion": 0.26,
      "outputUsdPerMillion": 2.6,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/Qwen/Qwen3.6-35B-A3B": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.95,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/nvidia/Nemotron-Content-Safety-3.5": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/anthropic/claude-opus-5": {
      "inputUsdPerMillion": 5,
      "outputUsdPerMillion": 25,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/thinkingmachines/Inkling": {
      "inputUsdPerMillion": 0.95,
      "outputUsdPerMillion": 4.05,
      "cacheReadUsdPerMillion": 0.16,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/moonshotai/Kimi-K2.6": {
      "inputUsdPerMillion": 0.75,
      "outputUsdPerMillion": 3.5,
      "cacheReadUsdPerMillion": 0.15,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/deepseek-ai/DeepSeek-V4-Pro-0813": {
      "inputUsdPerMillion": 1.3,
      "outputUsdPerMillion": 2.6,
      "cacheReadUsdPerMillion": 0.09999999999999999,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/Qwen/Qwen3.7-Max": {
      "inputUsdPerMillion": 2.5,
      "outputUsdPerMillion": 7.5,
      "cacheReadUsdPerMillion": 0.5,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/ByteDance/Seed-2.0-mini": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.39999999999999997,
      "cacheReadUsdPerMillion": 0.02,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/Qwen/Qwen3.8-2.4T-A95B": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 6,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/MiniMaxAI/MiniMax-M3": {
      "inputUsdPerMillion": 0.28,
      "outputUsdPerMillion": 1.1,
      "cacheReadUsdPerMillion": 0.056,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/google/gemini-3.1-flash-lite": {
      "inputUsdPerMillion": 0.25,
      "outputUsdPerMillion": 1.5,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/google/gemini-3.7-flash": {
      "inputUsdPerMillion": 0.75,
      "outputUsdPerMillion": 3.75,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/inclusionAI/Ling-3.0-flash": {
      "inputUsdPerMillion": 0.06,
      "outputUsdPerMillion": 0.18,
      "cacheReadUsdPerMillion": 0.012,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/stepfun-ai/Step-3.7-Flash": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 1.15,
      "cacheReadUsdPerMillion": 0.04,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/Qwen/Qwen3.5-35B-A3B": {
      "inputUsdPerMillion": 0.14,
      "outputUsdPerMillion": 1,
      "cacheReadUsdPerMillion": 0.049999999999999996,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/ByteDance/Seed-1.8": {
      "inputUsdPerMillion": 0.25,
      "outputUsdPerMillion": 2,
      "cacheReadUsdPerMillion": 0.049999999999999996,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/tencent/Hy3": {
      "inputUsdPerMillion": 0.14,
      "outputUsdPerMillion": 0.58,
      "cacheReadUsdPerMillion": 0.035,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/ByteDance/Seed-2.0-code": {
      "inputUsdPerMillion": 0.5,
      "outputUsdPerMillion": 3,
      "cacheReadUsdPerMillion": 0.09999999999999999,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/ByteDance/Seed-2.0-pro": {
      "inputUsdPerMillion": 0.5,
      "outputUsdPerMillion": 3,
      "cacheReadUsdPerMillion": 0.09999999999999999,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/zai-org/GLM-5": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 2.08,
      "cacheReadUsdPerMillion": 0.12,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/nvidia/Nemotron-3-Nano-30B-A3B": {
      "inputUsdPerMillion": 0.049999999999999996,
      "outputUsdPerMillion": 0.19999999999999998,
      "cacheReadUsdPerMillion": 0.024999999999999998,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/moonshotai/Kimi-K2.7-Code": {
      "inputUsdPerMillion": 0.6799999999999999,
      "outputUsdPerMillion": 3.4,
      "cacheReadUsdPerMillion": 0.136,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/anthropic/claude-sonnet-5": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 10,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/Qwen/Qwen3.5-397B-A17B": {
      "inputUsdPerMillion": 0.44999999999999996,
      "outputUsdPerMillion": 3,
      "cacheReadUsdPerMillion": 0.22,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/deepseek-ai/DeepSeek-V4-Flash-0731": {
      "inputUsdPerMillion": 0.08,
      "outputUsdPerMillion": 0.18,
      "cacheReadUsdPerMillion": 0.016,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/google/gemma-4-E4B-it": {
      "inputUsdPerMillion": 0.02,
      "outputUsdPerMillion": 0.09999999999999999,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/deepseek-ai/DeepSeek-V3.2": {
      "inputUsdPerMillion": 0.26,
      "outputUsdPerMillion": 0.38,
      "cacheReadUsdPerMillion": 0.13,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/Qwen/Qwen3.8-Max": {
      "inputUsdPerMillion": 1.6500000000000001,
      "outputUsdPerMillion": 4.951,
      "cacheReadUsdPerMillion": 0.206,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/anthropic/claude-fable-5": {
      "inputUsdPerMillion": 10,
      "outputUsdPerMillion": 50,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B": {
      "inputUsdPerMillion": 0.5,
      "outputUsdPerMillion": 2.2,
      "cacheReadUsdPerMillion": 0.09999999999999999,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/Qwen/Qwen3.5-122B-A10B": {
      "inputUsdPerMillion": 0.29,
      "outputUsdPerMillion": 2.4,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/zai-org/GLM-5.1": {
      "inputUsdPerMillion": 1.0499999999999998,
      "outputUsdPerMillion": 3.5,
      "cacheReadUsdPerMillion": 0.205,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/deepseek-ai/DeepSeek-V4-Pro": {
      "inputUsdPerMillion": 1.3,
      "outputUsdPerMillion": 2.6,
      "cacheReadUsdPerMillion": 0.09999999999999999,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/nvidia/NVIDIA-Nemotron-3-Super-120B-A12B": {
      "inputUsdPerMillion": 0.08499999999999999,
      "outputUsdPerMillion": 0.39999999999999997,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/zai-org/GLM-5.2": {
      "inputUsdPerMillion": 0.75,
      "outputUsdPerMillion": 2.4,
      "cacheReadUsdPerMillion": 0.14,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/moonshotai/Kimi-K3": {
      "inputUsdPerMillion": 2.8499999999999996,
      "outputUsdPerMillion": 14.25,
      "cacheReadUsdPerMillion": 0.28500000000000003,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/anthropic/claude-opus-4-7": {
      "inputUsdPerMillion": 5,
      "outputUsdPerMillion": 25,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/Qwen/Qwen3.6-27B": {
      "inputUsdPerMillion": 0.32,
      "outputUsdPerMillion": 3.1999999999999997,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/google/gemma-4-26B-A4B-it": {
      "inputUsdPerMillion": 0.07,
      "outputUsdPerMillion": 0.33999999999999997,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/google/gemini-3.1-pro": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 12,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/XiaomiMiMo/MiMo-V2.5-Pro": {
      "inputUsdPerMillion": 1,
      "outputUsdPerMillion": 3,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/anthropic/claude-haiku-4-5": {
      "inputUsdPerMillion": 1,
      "outputUsdPerMillion": 5,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/deepseek-ai/DeepSeek-V4-Flash": {
      "inputUsdPerMillion": 0.09,
      "outputUsdPerMillion": 0.18,
      "cacheReadUsdPerMillion": 0.018,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/openai/gpt-oss-120b-Ultra": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.95,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/Qwen/Qwen3.5-9B": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.15,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/MiniMaxAI/MiniMax-M2.7-Turbo": {
      "inputUsdPerMillion": 0.38,
      "outputUsdPerMillion": 1.7,
      "cacheReadUsdPerMillion": 0.07,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/zai-org/GLM-4.7": {
      "inputUsdPerMillion": 0.39999999999999997,
      "outputUsdPerMillion": 1.75,
      "cacheReadUsdPerMillion": 0.08,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "deepinfra/google/gemma-4-31B-it": {
      "inputUsdPerMillion": 0.13,
      "outputUsdPerMillion": 0.38,
      "provider": "deepinfra",
      "sourceUrl": "https://deepinfra.com/pricing"
    },
    "gemini/gemini-omni-1.1-flash": {
      "inputUsdPerMillion": 1.5,
      "outputUsdPerMillion": 9,
      "reasoningUsdPerMillion": 9,
      "provider": "gemini",
      "sourceUrl": "https://ai.google.dev/gemini-api/docs/pricing"
    },
    "xai/grok-4.20": {
      "inputUsdPerMillion": 1.25,
      "outputUsdPerMillion": 2.5,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "provider": "xai",
      "sourceUrl": "https://api.x.ai/v1/language-models"
    },
    "xai/grok-4.20-reasoning": {
      "inputUsdPerMillion": 1.25,
      "outputUsdPerMillion": 2.5,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "provider": "xai",
      "sourceUrl": "https://api.x.ai/v1/language-models"
    },
    "xai/grok-4.20-reasoning-latest": {
      "inputUsdPerMillion": 1.25,
      "outputUsdPerMillion": 2.5,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "provider": "xai",
      "sourceUrl": "https://api.x.ai/v1/language-models"
    },
    "xai/grok-4.20-non-reasoning": {
      "inputUsdPerMillion": 1.25,
      "outputUsdPerMillion": 2.5,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "provider": "xai",
      "sourceUrl": "https://api.x.ai/v1/language-models"
    },
    "xai/grok-4.20-non-reasoning-latest": {
      "inputUsdPerMillion": 1.25,
      "outputUsdPerMillion": 2.5,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "provider": "xai",
      "sourceUrl": "https://api.x.ai/v1/language-models"
    },
    "groq/qwen/qwen3.8-27b": {
      "inputUsdPerMillion": 0.7999999999999999,
      "outputUsdPerMillion": 4,
      "provider": "groq",
      "sourceUrl": "https://console.groq.com/docs/model/qwen/qwen3.8-27b"
    },
    "mistral/mistral-medium-3.5": {
      "inputUsdPerMillion": 1.5,
      "outputUsdPerMillion": 7.5,
      "cacheReadUsdPerMillion": 0.15,
      "provider": "mistral",
      "sourceUrl": "https://docs.mistral.ai/models/model-cards/mistral-medium-3-5-26-04"
    },
    "mistral/mistral-vibe-cli-latest": {
      "inputUsdPerMillion": 1.5,
      "outputUsdPerMillion": 7.5,
      "cacheReadUsdPerMillion": 0.15,
      "provider": "mistral",
      "sourceUrl": "https://docs.mistral.ai/models/model-cards/mistral-medium-3-5-26-04"
    },
    "mistral/mistral-vibe-cli-with-tools": {
      "inputUsdPerMillion": 1.5,
      "outputUsdPerMillion": 7.5,
      "cacheReadUsdPerMillion": 0.15,
      "provider": "mistral",
      "sourceUrl": "https://docs.mistral.ai/models/model-cards/mistral-medium-3-5-26-04"
    },
    "mistral/mistral-vibe-cli-fast": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.6,
      "cacheReadUsdPerMillion": 0.015,
      "provider": "mistral",
      "sourceUrl": "https://docs.mistral.ai/models/model-cards/mistral-small-4-0-26-03"
    },
    "mistral/mistral-code-latest": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 0.8999999999999999,
      "cacheReadUsdPerMillion": 0.03,
      "provider": "mistral",
      "sourceUrl": "https://docs.mistral.ai/models/model-cards/codestral-25-08"
    },
    "mistral/mistral-code-fim-latest": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 0.8999999999999999,
      "cacheReadUsdPerMillion": 0.03,
      "provider": "mistral",
      "sourceUrl": "https://docs.mistral.ai/models/model-cards/codestral-25-08"
    },
    "mistral/mistral-code-agent-latest": {
      "inputUsdPerMillion": 0.39999999999999997,
      "outputUsdPerMillion": 2,
      "cacheReadUsdPerMillion": 0.04,
      "provider": "mistral",
      "sourceUrl": "https://mistral.ai/news/devstral-2-vibe-cli"
    },
    "mistral/labs-leanstral-1-5-1": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "mistral",
      "sourceUrl": "https://docs.mistral.ai/models/model-cards/leanstral-1-5"
    },
    "fireworks_ai/accounts/fireworks/models/glm-5p3": {
      "inputUsdPerMillion": 1.4,
      "outputUsdPerMillion": 4.4,
      "cacheReadUsdPerMillion": 0.26,
      "provider": "fireworks_ai",
      "sourceUrl": "https://api.fireworks.ai/v1/serverless/models"
    },
    "fireworks_ai/accounts/fireworks/routers/glm-5p3-us": {
      "inputUsdPerMillion": 2.0999999999999996,
      "outputUsdPerMillion": 6.6000000000000005,
      "cacheReadUsdPerMillion": 0.39,
      "provider": "fireworks_ai",
      "sourceUrl": "https://docs.fireworks.ai/serverless/pricing"
    },
    "fireworks_ai/glm-5p3": {
      "inputUsdPerMillion": 1.4,
      "outputUsdPerMillion": 4.4,
      "cacheReadUsdPerMillion": 0.26,
      "provider": "fireworks_ai",
      "sourceUrl": "https://api.fireworks.ai/v1/serverless/models"
    },
    "fireworks_ai/glm-5p3-us": {
      "inputUsdPerMillion": 2.0999999999999996,
      "outputUsdPerMillion": 6.6000000000000005,
      "cacheReadUsdPerMillion": 0.39,
      "provider": "fireworks_ai",
      "sourceUrl": "https://docs.fireworks.ai/serverless/pricing"
    },
    "fireworks_ai/accounts/fireworks/routers/glm-5p3-fast": {
      "inputUsdPerMillion": 2.0999999999999996,
      "outputUsdPerMillion": 6.6000000000000005,
      "cacheReadUsdPerMillion": 0.39,
      "provider": "fireworks_ai",
      "sourceUrl": "https://api.fireworks.ai/v1/serverless/models"
    },
    "fireworks_ai/glm-5p3-fast": {
      "inputUsdPerMillion": 2.0999999999999996,
      "outputUsdPerMillion": 6.6000000000000005,
      "cacheReadUsdPerMillion": 0.39,
      "provider": "fireworks_ai",
      "sourceUrl": "https://docs.fireworks.ai/serverless/pricing"
    },
    "fireworks_ai/accounts/fireworks/models/glm-5p3-flash": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.5,
      "cacheReadUsdPerMillion": 0.03,
      "provider": "fireworks_ai",
      "sourceUrl": "https://api.fireworks.ai/v1/serverless/models"
    },
    "fireworks_ai/accounts/fireworks/routers/glm-5p3-flash-us": {
      "inputUsdPerMillion": 0.22499999999999998,
      "outputUsdPerMillion": 0.75,
      "cacheReadUsdPerMillion": 0.045,
      "provider": "fireworks_ai",
      "sourceUrl": "https://docs.fireworks.ai/serverless/pricing"
    },
    "fireworks_ai/glm-5p3-flash": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.5,
      "cacheReadUsdPerMillion": 0.03,
      "provider": "fireworks_ai",
      "sourceUrl": "https://api.fireworks.ai/v1/serverless/models"
    },
    "fireworks_ai/glm-5p3-flash-us": {
      "inputUsdPerMillion": 0.22499999999999998,
      "outputUsdPerMillion": 0.75,
      "cacheReadUsdPerMillion": 0.045,
      "provider": "fireworks_ai",
      "sourceUrl": "https://docs.fireworks.ai/serverless/pricing"
    },
    "fireworks_ai/accounts/fireworks/models/inkling": {
      "inputUsdPerMillion": 1,
      "outputUsdPerMillion": 4.05,
      "cacheReadUsdPerMillion": 0.16999999999999998,
      "provider": "fireworks_ai",
      "sourceUrl": "https://api.fireworks.ai/v1/serverless/models?format=nested"
    },
    "zai/glm-5.2": {
      "inputUsdPerMillion": 1.4,
      "outputUsdPerMillion": 4.4,
      "cacheReadUsdPerMillion": 0.26,
      "cacheWriteUsdPerMillion": 0,
      "provider": "zai",
      "sourceUrl": "https://docs.z.ai/guides/overview/pricing"
    },
    "together_ai/Qwen/Qwen3.8-Flash": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.47,
      "provider": "together_ai",
      "sourceUrl": "https://api.together.ai/v1/models"
    },
    "together_ai/moonshotai/Kimi-K2.5-fp4": {
      "inputUsdPerMillion": 0.5,
      "outputUsdPerMillion": 2.8,
      "provider": "together_ai",
      "sourceUrl": "https://api.together.ai/v1/models"
    },
    "together_ai/MiniMaxAI/MiniMax-M2.7": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 1.2,
      "cacheReadUsdPerMillion": 0.06,
      "provider": "together_ai",
      "sourceUrl": "https://api.together.ai/v1/models"
    },
    "together_ai/deepseek-ai/DeepSeek-R1-0528": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 7,
      "provider": "together_ai",
      "sourceUrl": "https://api.together.ai/v1/models"
    },
    "together_ai/mistralai/Ministral-3-14B-Instruct-2512": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "together_ai",
      "sourceUrl": "https://api.together.ai/v1/models"
    },
    "together_ai/nvidia/NVIDIA-Nemotron-Nano-9B-v2": {
      "inputUsdPerMillion": 0.06,
      "outputUsdPerMillion": 0.25,
      "provider": "together_ai",
      "sourceUrl": "https://api.together.ai/v1/models"
    },
    "together_ai/mistralai/Mistral-7B-Instruct-v0.3": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "together_ai",
      "sourceUrl": "https://api.together.ai/v1/models"
    },
    "cerebras/gemma-4-31b": {
      "inputUsdPerMillion": 0.9900000000000001,
      "outputUsdPerMillion": 1.49,
      "provider": "cerebras",
      "sourceUrl": "https://api.cerebras.ai/public/v1/models/gemma-4-31b"
    },
    "scaleway/glm-5.2": {
      "inputUsdPerMillion": 1.7999999999999998,
      "outputUsdPerMillion": 5.5,
      "provider": "scaleway",
      "sourceUrl": "https://www.scaleway.com/en/pricing/model-as-a-service/"
    },
    "scaleway/deepseek-v4-flash-0731": {
      "inputUsdPerMillion": 0.39999999999999997,
      "outputUsdPerMillion": 0.7999999999999999,
      "cacheReadUsdPerMillion": 0.08,
      "provider": "scaleway",
      "sourceUrl": "https://www.scaleway.com/en/pricing/model-as-a-service/"
    },
    "azure_ai/kimi-k2.7-code": {
      "inputUsdPerMillion": 0.95,
      "outputUsdPerMillion": 4,
      "cacheReadUsdPerMillion": 0.19,
      "provider": "azure_ai",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure_ai/deepseek-v4.1-flash": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 1.2,
      "cacheReadUsdPerMillion": 0.006,
      "provider": "azure_ai",
      "sourceUrl": "https://techcommunity.microsoft.com/blog/azure-ai-foundry-blog/deepseek-v4-1-flash-is-coming-to-microsoft-foundry/4556431"
    },
    "azure_ai/FW-DeepSeek-V4.1-Flash": {
      "inputUsdPerMillion": 0.375,
      "outputUsdPerMillion": 1.5,
      "cacheReadUsdPerMillion": 0.008,
      "provider": "azure_ai",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure_ai/FW-DeepSeek-V4-Flash": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.31,
      "cacheReadUsdPerMillion": 0.03,
      "provider": "azure_ai",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure_ai/FW-GLM-5.3": {
      "inputUsdPerMillion": 1.75,
      "outputUsdPerMillion": 5.5,
      "cacheReadUsdPerMillion": 0.325,
      "provider": "azure_ai",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure_ai/FW-GLM-5.3-Flash": {
      "inputUsdPerMillion": 0.188,
      "outputUsdPerMillion": 0.625,
      "cacheReadUsdPerMillion": 0.038000000000000006,
      "provider": "azure_ai",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure_ai/FW-GPT-OSS-120B": {
      "inputUsdPerMillion": 0.165,
      "outputUsdPerMillion": 0.66,
      "cacheReadUsdPerMillion": 0.082,
      "provider": "azure_ai",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure_ai/Cohere-command-a-plus-05-2026": {
      "inputUsdPerMillion": 0.7999999999999999,
      "outputUsdPerMillion": 3.1999999999999997,
      "provider": "azure_ai",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure_ai/mistral-medium-3-5": {
      "inputUsdPerMillion": 1.5,
      "outputUsdPerMillion": 7.5,
      "provider": "azure_ai",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure_ai/deepseek-r1": {
      "inputUsdPerMillion": 1.35,
      "outputUsdPerMillion": 5.4,
      "provider": "azure_ai",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure_ai/deepseek-v3-0324": {
      "inputUsdPerMillion": 1.1400000000000001,
      "outputUsdPerMillion": 4.5600000000000005,
      "provider": "azure_ai",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure_ai/deepseek-v3.1": {
      "inputUsdPerMillion": 1.23,
      "outputUsdPerMillion": 4.94,
      "provider": "azure_ai",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure_ai/grok-3": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 15,
      "provider": "azure_ai",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure_ai/grok-3-mini": {
      "inputUsdPerMillion": 0.25,
      "outputUsdPerMillion": 1.27,
      "provider": "azure_ai",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure_ai/grok-4-fast-non-reasoning": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.5,
      "provider": "azure_ai",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure_ai/grok-4-fast-reasoning": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.5,
      "provider": "azure_ai",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "bedrock/us-gov-west-1/nvidia.nemotron-nano-3-30b": {
      "inputUsdPerMillion": 0.072,
      "outputUsdPerMillion": 0.288,
      "provider": "bedrock",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "bedrock/us-gov-west-1/nvidia.nemotron-nano-12b-v2": {
      "inputUsdPerMillion": 0.24,
      "outputUsdPerMillion": 0.72,
      "provider": "bedrock",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-nvidia-nvidia-nemotron-nano-12b-v2-vl-bf16.html"
    },
    "bedrock/us-gov-west-1/nvidia.nemotron-nano-9b-v2": {
      "inputUsdPerMillion": 0.072,
      "outputUsdPerMillion": 0.27599999999999997,
      "provider": "bedrock",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-nvidia-nvidia-nemotron-nano-9b-v2.html"
    },
    "bedrock/us-gov-west-1/nvidia.nemotron-super-3-120b": {
      "inputUsdPerMillion": 0.18,
      "outputUsdPerMillion": 0.78,
      "provider": "bedrock",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "bedrock/us-gov-west-1/openai.gpt-oss-20b-1:0": {
      "inputUsdPerMillion": 0.08399999999999999,
      "outputUsdPerMillion": 0.36,
      "provider": "bedrock",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-oss-20b.html"
    },
    "bedrock/us-gov-west-1/openai.gpt-oss-120b-1:0": {
      "inputUsdPerMillion": 0.18,
      "outputUsdPerMillion": 0.72,
      "provider": "bedrock",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-oss-120b.html"
    },
    "bedrock/us-gov-west-1/anthropic.claude-sonnet-5": {
      "inputUsdPerMillion": 2.4,
      "outputUsdPerMillion": 12,
      "cacheReadUsdPerMillion": 0.24,
      "cacheWriteUsdPerMillion": 3,
      "provider": "bedrock"
    },
    "bedrock/us-gov-west-1/anthropic.claude-opus-4-8": {
      "inputUsdPerMillion": 6,
      "outputUsdPerMillion": 30,
      "cacheReadUsdPerMillion": 0.6,
      "cacheWriteUsdPerMillion": 7.5,
      "provider": "bedrock"
    },
    "bedrock/us-gov-west-1/anthropic.claude-opus-5": {
      "inputUsdPerMillion": 6,
      "outputUsdPerMillion": 30,
      "cacheReadUsdPerMillion": 0.6,
      "cacheWriteUsdPerMillion": 7.5,
      "provider": "bedrock"
    },
    "bedrock/us-gov-west-1/anthropic.claude-opus-5-5": {
      "inputUsdPerMillion": 4.8,
      "outputUsdPerMillion": 24,
      "cacheReadUsdPerMillion": 0.24,
      "cacheWriteUsdPerMillion": 6,
      "provider": "bedrock",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "bedrock/us-gov-west-1/anthropic.claude-fable-5-1": {
      "inputUsdPerMillion": 12,
      "outputUsdPerMillion": 60,
      "cacheReadUsdPerMillion": 0.3,
      "cacheWriteUsdPerMillion": 15,
      "provider": "bedrock"
    },
    "bedrock/us-gov-east-1/nvidia.nemotron-nano-3-30b": {
      "inputUsdPerMillion": 0.072,
      "outputUsdPerMillion": 0.288,
      "provider": "bedrock",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "bedrock/us-gov-east-1/nvidia.nemotron-nano-12b-v2": {
      "inputUsdPerMillion": 0.24,
      "outputUsdPerMillion": 0.72,
      "provider": "bedrock",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-nvidia-nvidia-nemotron-nano-12b-v2-vl-bf16.html"
    },
    "bedrock/us-gov-east-1/nvidia.nemotron-nano-9b-v2": {
      "inputUsdPerMillion": 0.072,
      "outputUsdPerMillion": 0.27599999999999997,
      "provider": "bedrock",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-nvidia-nvidia-nemotron-nano-9b-v2.html"
    },
    "bedrock/us-gov-east-1/nvidia.nemotron-super-3-120b": {
      "inputUsdPerMillion": 0.18,
      "outputUsdPerMillion": 0.78,
      "provider": "bedrock",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "bedrock/us-gov-east-1/openai.gpt-oss-20b-1:0": {
      "inputUsdPerMillion": 0.08399999999999999,
      "outputUsdPerMillion": 0.36,
      "provider": "bedrock",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-oss-20b.html"
    },
    "bedrock/us-gov-east-1/openai.gpt-oss-120b-1:0": {
      "inputUsdPerMillion": 0.18,
      "outputUsdPerMillion": 0.72,
      "provider": "bedrock",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-oss-120b.html"
    },
    "bedrock/us-gov-east-1/anthropic.claude-sonnet-5": {
      "inputUsdPerMillion": 2.4,
      "outputUsdPerMillion": 12,
      "cacheReadUsdPerMillion": 0.24,
      "cacheWriteUsdPerMillion": 3,
      "provider": "bedrock"
    },
    "bedrock/us-gov-east-1/anthropic.claude-opus-4-8": {
      "inputUsdPerMillion": 6,
      "outputUsdPerMillion": 30,
      "cacheReadUsdPerMillion": 0.6,
      "cacheWriteUsdPerMillion": 7.5,
      "provider": "bedrock"
    },
    "bedrock/us-gov-east-1/anthropic.claude-opus-5": {
      "inputUsdPerMillion": 6,
      "outputUsdPerMillion": 30,
      "cacheReadUsdPerMillion": 0.6,
      "cacheWriteUsdPerMillion": 7.5,
      "provider": "bedrock"
    },
    "bedrock/us-gov-east-1/anthropic.claude-opus-5-5": {
      "inputUsdPerMillion": 4.8,
      "outputUsdPerMillion": 24,
      "cacheReadUsdPerMillion": 0.24,
      "cacheWriteUsdPerMillion": 6,
      "provider": "bedrock",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "bedrock/us-gov-east-1/anthropic.claude-fable-5-1": {
      "inputUsdPerMillion": 12,
      "outputUsdPerMillion": 60,
      "cacheReadUsdPerMillion": 0.3,
      "cacheWriteUsdPerMillion": 15,
      "provider": "bedrock"
    },
    "bedrock_mantle/us-gov-west-1/xai.grok-4.3": {
      "inputUsdPerMillion": 1.5,
      "outputUsdPerMillion": 3,
      "cacheReadUsdPerMillion": 0.24,
      "provider": "bedrock_mantle",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "bedrock_mantle/us-gov-west-1/xai.grok-4.6": {
      "inputUsdPerMillion": 2.64,
      "outputUsdPerMillion": 7.920000000000001,
      "cacheReadUsdPerMillion": 0.66,
      "provider": "bedrock_mantle"
    },
    "bedrock_mantle/us-gov-west-1/google.gemma-4-e2b": {
      "inputUsdPerMillion": 0.048,
      "outputUsdPerMillion": 0.096,
      "provider": "bedrock_mantle"
    },
    "bedrock_mantle/us-gov-west-1/google.gemma-4-26b-a4b": {
      "inputUsdPerMillion": 0.156,
      "outputUsdPerMillion": 0.48,
      "provider": "bedrock_mantle"
    },
    "bedrock_mantle/us-gov-west-1/google.gemma-4-31b": {
      "inputUsdPerMillion": 0.16799999999999998,
      "outputUsdPerMillion": 0.48,
      "provider": "bedrock_mantle"
    },
    "bedrock_mantle/us-gov-west-1/openai.gpt-oss-20b": {
      "inputUsdPerMillion": 0.08399999999999999,
      "outputUsdPerMillion": 0.36,
      "provider": "bedrock_mantle",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-oss-20b.html"
    },
    "bedrock_mantle/us-gov-west-1/openai.gpt-oss-120b": {
      "inputUsdPerMillion": 0.18,
      "outputUsdPerMillion": 0.72,
      "provider": "bedrock_mantle",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-oss-120b.html"
    },
    "bedrock_mantle/us-gov-west-1/anthropic.claude-opus-5-5": {
      "inputUsdPerMillion": 4.8,
      "outputUsdPerMillion": 24,
      "cacheReadUsdPerMillion": 0.24,
      "cacheWriteUsdPerMillion": 6,
      "provider": "bedrock_mantle",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-opus-5-5.html"
    },
    "bedrock_mantle/us-gov-west-1/anthropic.claude-sonnet-5-5": {
      "inputUsdPerMillion": 2.4,
      "outputUsdPerMillion": 12,
      "cacheReadUsdPerMillion": 0.12,
      "cacheWriteUsdPerMillion": 3,
      "provider": "bedrock_mantle",
      "sourceUrl": "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrockFoundationModels/current/index.json"
    },
    "bedrock_mantle/us-gov-east-1/xai.grok-4.6": {
      "inputUsdPerMillion": 2.64,
      "outputUsdPerMillion": 7.920000000000001,
      "cacheReadUsdPerMillion": 0.66,
      "provider": "bedrock_mantle"
    },
    "bedrock_mantle/us-gov-east-1/openai.gpt-oss-20b": {
      "inputUsdPerMillion": 0.08399999999999999,
      "outputUsdPerMillion": 0.36,
      "provider": "bedrock_mantle",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-oss-20b.html"
    },
    "bedrock_mantle/us-gov-east-1/openai.gpt-oss-120b": {
      "inputUsdPerMillion": 0.18,
      "outputUsdPerMillion": 0.72,
      "provider": "bedrock_mantle",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-oss-120b.html"
    },
    "bedrock_mantle/deepseek.v3.1": {
      "inputUsdPerMillion": 0.58,
      "outputUsdPerMillion": 1.68,
      "provider": "bedrock_mantle",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-deepseek-deepseek-v3-1.html"
    },
    "bedrock_mantle/moonshotai.kimi-k2-thinking": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 2.5,
      "provider": "bedrock_mantle",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-moonshot-ai-kimi-k2-thinking.html"
    },
    "bedrock_mantle/qwen.qwen3-235b-a22b-2507": {
      "inputUsdPerMillion": 0.22,
      "outputUsdPerMillion": 0.88,
      "provider": "bedrock_mantle",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-qwen-qwen3-235b-a22b-2507.html"
    },
    "bedrock_mantle/qwen.qwen3-32b": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.6,
      "provider": "bedrock_mantle",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-qwen-qwen3-32b.html"
    },
    "bedrock_mantle/qwen.qwen3-coder-30b-a3b-instruct": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.6,
      "provider": "bedrock_mantle",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-qwen-qwen3-coder-30b-a3b-instruct.html"
    },
    "bedrock_mantle/qwen.qwen3-coder-480b-a35b-instruct": {
      "inputUsdPerMillion": 0.44999999999999996,
      "outputUsdPerMillion": 1.7999999999999998,
      "provider": "bedrock_mantle",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-qwen-qwen3-coder-480b-a35b-instruct.html"
    },
    "bedrock_mantle/qwen.qwen3-next-80b-a3b-instruct": {
      "inputUsdPerMillion": 0.14,
      "outputUsdPerMillion": 1.2,
      "provider": "bedrock_mantle",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-qwen-qwen3-next-80b-a3b.html"
    },
    "bedrock_mantle/qwen.qwen3-vl-235b-a22b-instruct": {
      "inputUsdPerMillion": 0.53,
      "outputUsdPerMillion": 2.66,
      "provider": "bedrock_mantle",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-qwen-qwen3-vl-235b-a22b.html"
    },
    "azure/us-gov/gpt-5.1": {
      "inputUsdPerMillion": 1.71875,
      "outputUsdPerMillion": 13.75,
      "cacheReadUsdPerMillion": 0.171875,
      "provider": "azure"
    },
    "azure/us-gov/o3-mini": {
      "inputUsdPerMillion": 1.513,
      "outputUsdPerMillion": 6.05,
      "cacheReadUsdPerMillion": 0.757,
      "provider": "azure"
    },
    "gemini/lyria-3.5-clip-preview": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "gemini",
      "sourceUrl": "https://ai.google.dev/gemini-api/docs/pricing"
    },
    "gemini/lyria-3.5-pro-preview": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "gemini",
      "sourceUrl": "https://ai.google.dev/gemini-api/docs/pricing"
    },
    "gemini/lyria-3.5": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "gemini",
      "sourceUrl": "https://ai.google.dev/gemini-api/docs/pricing"
    },
    "gemini/lyria-realtime-exp": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "gemini",
      "sourceUrl": "https://ai.google.dev/gemini-api/docs/models/lyria-realtime-exp"
    },
    "baseten/zai-org/GLM-5.3": {
      "inputUsdPerMillion": 1.4,
      "outputUsdPerMillion": 4.4,
      "cacheReadUsdPerMillion": 0.14,
      "provider": "baseten",
      "sourceUrl": "https://inference.baseten.co/v1/models"
    },
    "baseten/zai-org/GLM-5.3-Fast": {
      "inputUsdPerMillion": 2.0999999999999996,
      "outputUsdPerMillion": 6.6000000000000005,
      "cacheReadUsdPerMillion": 0.21,
      "provider": "baseten",
      "sourceUrl": "https://inference.baseten.co/v1/models"
    },
    "together_ai/arcee-ai/trinity-mini": {
      "inputUsdPerMillion": 0.045,
      "outputUsdPerMillion": 0.15,
      "provider": "together_ai",
      "sourceUrl": "https://api.together.ai/v1/models"
    },
    "vertex_ai/gemini-omni-1.1-flash": {
      "inputUsdPerMillion": 1.5,
      "outputUsdPerMillion": 9,
      "reasoningUsdPerMillion": 9,
      "provider": "vertex_ai",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "vertex_ai/gemini-omni-1.1-flash-preview": {
      "inputUsdPerMillion": 1.5,
      "outputUsdPerMillion": 9,
      "reasoningUsdPerMillion": 9,
      "provider": "vertex_ai",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "vertex_ai/gemma-4-26b-a4b-it": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.6,
      "cacheReadUsdPerMillion": 0.015,
      "provider": "vertex_ai",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "gpt-5.5-cyber": {
      "inputUsdPerMillion": 12.5,
      "outputUsdPerMillion": 75,
      "cacheReadUsdPerMillion": 1.25,
      "provider": "openai",
      "sourceUrl": "https://developers.openai.com/api/docs/pricing"
    },
    "gpt-rosalind-research": {
      "inputUsdPerMillion": 5,
      "outputUsdPerMillion": 25,
      "cacheReadUsdPerMillion": 0.5,
      "provider": "openai",
      "sourceUrl": "https://developers.openai.com/api/docs/pricing"
    },
    "together_ai/meta-llama/Llama-3.1-405B-Instruct": {
      "inputUsdPerMillion": 3.5,
      "outputUsdPerMillion": 3.5,
      "provider": "together_ai",
      "sourceUrl": "https://api.together.ai/v1/models"
    },
    "together_ai/meta-llama/Llama-3.2-1B-Instruct": {
      "inputUsdPerMillion": 0.06,
      "outputUsdPerMillion": 0.06,
      "provider": "together_ai",
      "sourceUrl": "https://api.together.ai/v1/models"
    },
    "together_ai/meta-llama/Llama-3.2-3B-Instruct": {
      "inputUsdPerMillion": 0.06,
      "outputUsdPerMillion": 0.06,
      "provider": "together_ai",
      "sourceUrl": "https://api.together.ai/v1/models"
    },
    "together_ai/Qwen/Qwen2-1.5B-Instruct": {
      "inputUsdPerMillion": 0.02,
      "outputUsdPerMillion": 0.02,
      "provider": "together_ai",
      "sourceUrl": "https://api.together.ai/v1/models"
    },
    "together_ai/Qwen/Qwen2.5-14B-Instruct": {
      "inputUsdPerMillion": 0.7999999999999999,
      "outputUsdPerMillion": 0.7999999999999999,
      "provider": "together_ai",
      "sourceUrl": "https://api.together.ai/v1/models"
    },
    "together_ai/Qwen/Qwen2.5-72B-Instruct": {
      "inputUsdPerMillion": 1.2,
      "outputUsdPerMillion": 1.2,
      "provider": "together_ai",
      "sourceUrl": "https://api.together.ai/v1/models"
    },
    "together_ai/meta-llama/Meta-Llama-3.1-8B": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "together_ai",
      "sourceUrl": "https://api.together.xyz/v1/models"
    },
    "together_ai/together/Tev1-4B-experimental": {
      "inputUsdPerMillion": 0.041999999999999996,
      "outputUsdPerMillion": 0,
      "cacheReadUsdPerMillion": 0.041999999999999996,
      "provider": "together_ai",
      "sourceUrl": "https://api.together.ai/v1/models"
    },
    "together_ai/NousResearch/Nous-Hermes-2-Mixtral-8x7B-DPO": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 0.6,
      "provider": "together_ai",
      "sourceUrl": "https://api.together.ai/v1/models"
    },
    "together_ai/Qwen/QwQ-32B": {
      "inputUsdPerMillion": 1.2,
      "outputUsdPerMillion": 1.2,
      "provider": "together_ai",
      "sourceUrl": "https://api.together.ai/v1/models"
    },
    "together_ai/Qwen/Qwen2-72B-Instruct": {
      "inputUsdPerMillion": 0.8999999999999999,
      "outputUsdPerMillion": 0.8999999999999999,
      "provider": "together_ai",
      "sourceUrl": "https://api.together.ai/v1/models"
    },
    "together_ai/Qwen/Qwen2-VL-72B-Instruct": {
      "inputUsdPerMillion": 1.2,
      "outputUsdPerMillion": 1.2,
      "provider": "together_ai",
      "sourceUrl": "https://api.together.ai/v1/models"
    },
    "together_ai/Qwen/Qwen2.5-72B-Instruct-Turbo": {
      "inputUsdPerMillion": 1.2,
      "outputUsdPerMillion": 1.2,
      "provider": "together_ai",
      "sourceUrl": "https://api.together.ai/v1/models"
    },
    "together_ai/Qwen/Qwen2.5-Coder-32B-Instruct": {
      "inputUsdPerMillion": 0.7999999999999999,
      "outputUsdPerMillion": 0.7999999999999999,
      "provider": "together_ai",
      "sourceUrl": "https://api.together.ai/v1/models"
    },
    "together_ai/Qwen/Qwen2.5-VL-72B-Instruct": {
      "inputUsdPerMillion": 1.95,
      "outputUsdPerMillion": 8,
      "provider": "together_ai",
      "sourceUrl": "https://api.together.ai/v1/models"
    },
    "together_ai/Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 2,
      "provider": "together_ai",
      "sourceUrl": "https://api.together.ai/v1/models"
    },
    "together_ai/Qwen/Qwen3-Coder-Next-FP8": {
      "inputUsdPerMillion": 0.5,
      "outputUsdPerMillion": 1.2,
      "provider": "together_ai",
      "sourceUrl": "https://api.together.ai/v1/models"
    },
    "together_ai/Qwen/Qwen3-Next-80B-A3B-Instruct": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 1.5,
      "provider": "together_ai",
      "sourceUrl": "https://api.together.ai/v1/models"
    },
    "together_ai/Qwen/Qwen3-Next-80B-A3B-Thinking": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 1.5,
      "provider": "together_ai",
      "sourceUrl": "https://api.together.ai/v1/models"
    },
    "together_ai/Qwen/Qwen3-VL-32B-Instruct": {
      "inputUsdPerMillion": 0.5,
      "outputUsdPerMillion": 1.5,
      "provider": "together_ai",
      "sourceUrl": "https://api.together.ai/v1/models"
    },
    "together_ai/Qwen/Qwen3-VL-8B-Instruct": {
      "inputUsdPerMillion": 0.18,
      "outputUsdPerMillion": 0.6799999999999999,
      "provider": "together_ai",
      "sourceUrl": "https://api.together.ai/v1/models"
    },
    "together_ai/Qwen/Qwen3.5-397B-A17B": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 3.5999999999999996,
      "cacheReadUsdPerMillion": 0.35,
      "provider": "together_ai",
      "sourceUrl": "https://api.together.ai/v1/models"
    },
    "together_ai/deepseek-ai/DeepSeek-R1-Distill-Llama-70B": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 2,
      "provider": "together_ai",
      "sourceUrl": "https://api.together.ai/v1/models"
    },
    "together_ai/deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B": {
      "inputUsdPerMillion": 0.18,
      "outputUsdPerMillion": 0.18,
      "provider": "together_ai",
      "sourceUrl": "https://api.together.ai/v1/models"
    },
    "together_ai/deepseek-ai/DeepSeek-R1-Distill-Qwen-14B": {
      "inputUsdPerMillion": 1.5999999999999999,
      "outputUsdPerMillion": 1.5999999999999999,
      "provider": "together_ai",
      "sourceUrl": "https://api.together.ai/v1/models"
    },
    "together_ai/deepseek-ai/DeepSeek-V3.1": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 1.7,
      "provider": "together_ai",
      "sourceUrl": "https://api.together.ai/v1/models"
    },
    "together_ai/deepseek-ai/deepseek-coder-33b-instruct": {
      "inputUsdPerMillion": 0.7999999999999999,
      "outputUsdPerMillion": 0.7999999999999999,
      "provider": "together_ai",
      "sourceUrl": "https://api.together.ai/v1/models"
    },
    "together_ai/google/gemma-2-27b-it": {
      "inputUsdPerMillion": 0.7999999999999999,
      "outputUsdPerMillion": 0.7999999999999999,
      "provider": "together_ai",
      "sourceUrl": "https://api.together.ai/v1/models"
    },
    "together_ai/google/gemma-4-31B-it": {
      "inputUsdPerMillion": 0.39,
      "outputUsdPerMillion": 0.9700000000000001,
      "provider": "together_ai",
      "sourceUrl": "https://api.together.ai/v1/models"
    },
    "together_ai/meta-llama/Llama-3-8b-chat-hf": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "together_ai",
      "sourceUrl": "https://api.together.ai/v1/models"
    },
    "together_ai/meta-llama/Llama-4-Scout-17B-16E-Instruct": {
      "inputUsdPerMillion": 0.18,
      "outputUsdPerMillion": 0.59,
      "provider": "together_ai",
      "sourceUrl": "https://api.together.ai/v1/models"
    },
    "together_ai/meta-llama/Meta-Llama-3-70B-Instruct-Turbo": {
      "inputUsdPerMillion": 0.88,
      "outputUsdPerMillion": 0.88,
      "provider": "together_ai",
      "sourceUrl": "https://api.together.ai/v1/models"
    },
    "together_ai/meta-llama/Meta-Llama-3-8B-Instruct": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "together_ai",
      "sourceUrl": "https://api.together.ai/v1/models"
    },
    "together_ai/meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo": {
      "inputUsdPerMillion": 0.88,
      "outputUsdPerMillion": 0.88,
      "provider": "together_ai",
      "sourceUrl": "https://api.together.ai/v1/models"
    },
    "together_ai/meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo": {
      "inputUsdPerMillion": 0.18,
      "outputUsdPerMillion": 0.18,
      "provider": "together_ai",
      "sourceUrl": "https://api.together.ai/v1/models"
    },
    "together_ai/mistralai/Mistral-7B-Instruct-v0.1": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "together_ai",
      "sourceUrl": "https://api.together.ai/v1/models"
    },
    "together_ai/mistralai/Mistral-Small-24B-Instruct-2501": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.3,
      "provider": "together_ai",
      "sourceUrl": "https://api.together.ai/v1/models"
    },
    "together_ai/mistralai/Mixtral-8x7B-Instruct-v0.1": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 0.6,
      "provider": "together_ai",
      "sourceUrl": "https://api.together.ai/v1/models"
    },
    "together_ai/moonshotai/Kimi-K2.6": {
      "inputUsdPerMillion": 1.2,
      "outputUsdPerMillion": 4.5,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "provider": "together_ai",
      "sourceUrl": "https://api.together.ai/v1/models"
    },
    "together_ai/moonshotai/Kimi-K2.7-Code": {
      "inputUsdPerMillion": 0.95,
      "outputUsdPerMillion": 4,
      "cacheReadUsdPerMillion": 0.19,
      "provider": "together_ai",
      "sourceUrl": "https://api.together.ai/v1/models"
    },
    "together_ai/nvidia/Llama-3.1-Nemotron-70B-Instruct-HF": {
      "inputUsdPerMillion": 0.88,
      "outputUsdPerMillion": 0.88,
      "provider": "together_ai",
      "sourceUrl": "https://api.together.ai/v1/models"
    },
    "together_ai/nvidia/nemotron-3-ultra-550b-a55b": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 3.5999999999999996,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "provider": "together_ai",
      "sourceUrl": "https://api.together.ai/v1/models"
    },
    "together_ai/openai/gpt-oss-20b": {
      "inputUsdPerMillion": 0.049999999999999996,
      "outputUsdPerMillion": 0.19999999999999998,
      "provider": "together_ai",
      "sourceUrl": "https://api.together.ai/v1/models"
    },
    "together_ai/zai-org/GLM-4.5-Air-FP8": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 1.1,
      "provider": "together_ai",
      "sourceUrl": "https://api.together.ai/v1/models"
    },
    "together_ai/zai-org/GLM-4.7": {
      "inputUsdPerMillion": 0.44999999999999996,
      "outputUsdPerMillion": 2,
      "provider": "together_ai",
      "sourceUrl": "https://api.together.ai/v1/models"
    },
    "together_ai/zai-org/GLM-5": {
      "inputUsdPerMillion": 1,
      "outputUsdPerMillion": 3.1999999999999997,
      "provider": "together_ai",
      "sourceUrl": "https://api.together.ai/v1/models"
    },
    "together_ai/zai-org/GLM-5.1": {
      "inputUsdPerMillion": 1.4,
      "outputUsdPerMillion": 4.4,
      "cacheReadUsdPerMillion": 0.26,
      "provider": "together_ai",
      "sourceUrl": "https://api.together.ai/v1/models"
    },
    "azure/eu/computer-use-preview": {
      "inputUsdPerMillion": 3.3000000000000003,
      "outputUsdPerMillion": 13.200000000000001,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/eu/gpt-4.1": {
      "inputUsdPerMillion": 2.2,
      "outputUsdPerMillion": 8.8,
      "cacheReadUsdPerMillion": 0.55,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/eu/gpt-4.1-mini": {
      "inputUsdPerMillion": 0.44,
      "outputUsdPerMillion": 1.76,
      "cacheReadUsdPerMillion": 0.11,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/eu/gpt-4.1-nano": {
      "inputUsdPerMillion": 0.11,
      "outputUsdPerMillion": 0.44,
      "cacheReadUsdPerMillion": 0.028,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/eu/gpt-4o-2024-05-13": {
      "inputUsdPerMillion": 5.5,
      "outputUsdPerMillion": 16.5,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/eu/gpt-5": {
      "inputUsdPerMillion": 1.375,
      "outputUsdPerMillion": 11,
      "cacheReadUsdPerMillion": 0.1375,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/eu/gpt-5-mini": {
      "inputUsdPerMillion": 0.275,
      "outputUsdPerMillion": 2.2,
      "cacheReadUsdPerMillion": 0.0275,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/eu/gpt-5-nano": {
      "inputUsdPerMillion": 0.055,
      "outputUsdPerMillion": 0.44,
      "cacheReadUsdPerMillion": 0.0055,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/eu/gpt-5.2": {
      "inputUsdPerMillion": 1.9250000000000003,
      "outputUsdPerMillion": 15.400000000000002,
      "cacheReadUsdPerMillion": 0.1925,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/eu/gpt-5.4-mini": {
      "inputUsdPerMillion": 0.8250000000000001,
      "outputUsdPerMillion": 4.95,
      "cacheReadUsdPerMillion": 0.0825,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/eu/gpt-5.4-nano": {
      "inputUsdPerMillion": 0.22,
      "outputUsdPerMillion": 1.375,
      "cacheReadUsdPerMillion": 0.022,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/eu/gpt-6-astra": {
      "inputUsdPerMillion": 12,
      "outputUsdPerMillion": 60,
      "cacheReadUsdPerMillion": 1.2,
      "cacheWriteUsdPerMillion": 15,
      "provider": "azure",
      "sourceUrl": "https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/models-sold-directly-by-azure"
    },
    "azure/eu/gpt-6-luna": {
      "inputUsdPerMillion": 0.12,
      "outputUsdPerMillion": 0.6,
      "cacheReadUsdPerMillion": 0.012,
      "cacheWriteUsdPerMillion": 0.15,
      "provider": "azure",
      "sourceUrl": "https://azure.microsoft.com/en-us/blog/gpt-6-astra-sol-and-luna-for-production-agents-in-microsoft-foundry/"
    },
    "azure/eu/gpt-6-sol": {
      "inputUsdPerMillion": 2.4,
      "outputUsdPerMillion": 12,
      "cacheReadUsdPerMillion": 0.24,
      "cacheWriteUsdPerMillion": 3,
      "provider": "azure",
      "sourceUrl": "https://azure.microsoft.com/en-us/blog/gpt-6-astra-sol-and-luna-for-production-agents-in-microsoft-foundry/"
    },
    "azure/eu/o1-mini": {
      "inputUsdPerMillion": 1.21,
      "outputUsdPerMillion": 4.84,
      "cacheReadUsdPerMillion": 0.605,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/eu/o3-2025-04-16": {
      "inputUsdPerMillion": 2.2,
      "outputUsdPerMillion": 8.8,
      "cacheReadUsdPerMillion": 0.55,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/eu/o3-deep-research": {
      "inputUsdPerMillion": 11,
      "outputUsdPerMillion": 44,
      "cacheReadUsdPerMillion": 2.75,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/eu/o4-mini-2025-04-16": {
      "inputUsdPerMillion": 1.21,
      "outputUsdPerMillion": 4.84,
      "cacheReadUsdPerMillion": 0.303,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/us/computer-use-preview": {
      "inputUsdPerMillion": 3.3000000000000003,
      "outputUsdPerMillion": 13.200000000000001,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/us/gpt-4.1": {
      "inputUsdPerMillion": 2.2,
      "outputUsdPerMillion": 8.8,
      "cacheReadUsdPerMillion": 0.55,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/us/gpt-4.1-mini": {
      "inputUsdPerMillion": 0.44,
      "outputUsdPerMillion": 1.76,
      "cacheReadUsdPerMillion": 0.11,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/us/gpt-4.1-nano": {
      "inputUsdPerMillion": 0.11,
      "outputUsdPerMillion": 0.44,
      "cacheReadUsdPerMillion": 0.028,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/us/gpt-4o-2024-05-13": {
      "inputUsdPerMillion": 5.5,
      "outputUsdPerMillion": 16.5,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/us/gpt-5": {
      "inputUsdPerMillion": 1.375,
      "outputUsdPerMillion": 11,
      "cacheReadUsdPerMillion": 0.1375,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/us/gpt-5-mini": {
      "inputUsdPerMillion": 0.275,
      "outputUsdPerMillion": 2.2,
      "cacheReadUsdPerMillion": 0.0275,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/us/gpt-5-nano": {
      "inputUsdPerMillion": 0.055,
      "outputUsdPerMillion": 0.44,
      "cacheReadUsdPerMillion": 0.0055,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/us/gpt-5.2": {
      "inputUsdPerMillion": 1.9250000000000003,
      "outputUsdPerMillion": 15.400000000000002,
      "cacheReadUsdPerMillion": 0.1925,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/us/gpt-5.4-mini": {
      "inputUsdPerMillion": 0.8250000000000001,
      "outputUsdPerMillion": 4.95,
      "cacheReadUsdPerMillion": 0.0825,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/us/gpt-5.4-nano": {
      "inputUsdPerMillion": 0.22,
      "outputUsdPerMillion": 1.375,
      "cacheReadUsdPerMillion": 0.022,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/us/o1-mini": {
      "inputUsdPerMillion": 1.21,
      "outputUsdPerMillion": 4.84,
      "cacheReadUsdPerMillion": 0.605,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "azure/us/o3-deep-research": {
      "inputUsdPerMillion": 11,
      "outputUsdPerMillion": 44,
      "cacheReadUsdPerMillion": 2.75,
      "provider": "azure",
      "sourceUrl": "https://prices.azure.com/api/retail/prices?$filter=serviceName%20eq%20'Foundry%20Models'%20and%20armRegionName%20eq%20'eastus'%20and%20priceType%20eq%20'Consumption'"
    },
    "aihubmix/agnes-2.5-flash": {
      "inputUsdPerMillion": 0.03,
      "outputUsdPerMillion": 0.15,
      "provider": "aihubmix",
      "sourceUrl": "https://aihubmix.com/api/v1/models"
    },
    "aihubmix/agnes-2.5-pro": {
      "inputUsdPerMillion": 0.44999999999999996,
      "outputUsdPerMillion": 0.8999999999999999,
      "cacheReadUsdPerMillion": 0.00378,
      "provider": "aihubmix",
      "sourceUrl": "https://aihubmix.com/api/v1/models"
    },
    "aihubmix/cc-glm-5.1": {
      "inputUsdPerMillion": 0.06,
      "outputUsdPerMillion": 0.22,
      "provider": "aihubmix",
      "sourceUrl": "https://aihubmix.com/api/v1/models"
    },
    "aihubmix/claude-fable-5": {
      "inputUsdPerMillion": 11,
      "outputUsdPerMillion": 55,
      "cacheReadUsdPerMillion": 1.1,
      "cacheWriteUsdPerMillion": 13.75,
      "provider": "aihubmix",
      "sourceUrl": "https://aihubmix.com/api/v1/models"
    },
    "aihubmix/claude-haiku-4-5": {
      "inputUsdPerMillion": 1.1,
      "outputUsdPerMillion": 5.5,
      "cacheReadUsdPerMillion": 0.11,
      "cacheWriteUsdPerMillion": 1.375,
      "provider": "aihubmix",
      "sourceUrl": "https://aihubmix.com/api/v1/models"
    },
    "aihubmix/claude-opus-4-8-think": {
      "inputUsdPerMillion": 5,
      "outputUsdPerMillion": 25,
      "cacheReadUsdPerMillion": 0.5,
      "cacheWriteUsdPerMillion": 6.25,
      "provider": "aihubmix",
      "sourceUrl": "https://aihubmix.com/api/v1/models"
    },
    "aihubmix/claude-opus-5": {
      "inputUsdPerMillion": 5,
      "outputUsdPerMillion": 25,
      "cacheReadUsdPerMillion": 0.5,
      "cacheWriteUsdPerMillion": 6.25,
      "provider": "aihubmix",
      "sourceUrl": "https://aihubmix.com/api/v1/models"
    },
    "aihubmix/claude-sonnet-5": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 10,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "cacheWriteUsdPerMillion": 2.5,
      "provider": "aihubmix",
      "sourceUrl": "https://aihubmix.com/api/v1/models"
    },
    "aihubmix/coding-glm-5.3": {
      "inputUsdPerMillion": 0.06,
      "outputUsdPerMillion": 0.22,
      "cacheReadUsdPerMillion": 0.015,
      "provider": "aihubmix",
      "sourceUrl": "https://aihubmix.com/api/v1/models"
    },
    "aihubmix/coding-kimi-k3": {
      "inputUsdPerMillion": 0.44,
      "outputUsdPerMillion": 1.6133300000000002,
      "cacheReadUsdPerMillion": 0.06599999999999999,
      "provider": "aihubmix",
      "sourceUrl": "https://aihubmix.com/api/v1/models"
    },
    "aihubmix/coding-xiaomi-mimo-v2-omni": {
      "inputUsdPerMillion": 0.08,
      "outputUsdPerMillion": 0.39999999999999997,
      "cacheReadUsdPerMillion": 0.016,
      "provider": "aihubmix",
      "sourceUrl": "https://aihubmix.com/api/v1/models"
    },
    "aihubmix/coding-xiaomi-mimo-v2.5": {
      "inputUsdPerMillion": 0.08,
      "outputUsdPerMillion": 0.16,
      "cacheReadUsdPerMillion": 0.0016,
      "provider": "aihubmix",
      "sourceUrl": "https://aihubmix.com/api/v1/models"
    },
    "aihubmix/coding-xiaomi-mimo-v2.5-pro": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.39999999999999997,
      "cacheReadUsdPerMillion": 0.0016,
      "provider": "aihubmix",
      "sourceUrl": "https://aihubmix.com/api/v1/models"
    },
    "aihubmix/command-a-plus-05-2026": {
      "inputUsdPerMillion": 2.5,
      "outputUsdPerMillion": 10,
      "provider": "aihubmix",
      "sourceUrl": "https://aihubmix.com/api/v1/models"
    },
    "aihubmix/deepseek-v4-flash": {
      "inputUsdPerMillion": 0.142,
      "outputUsdPerMillion": 0.284,
      "cacheReadUsdPerMillion": 0.028399999999999998,
      "provider": "aihubmix",
      "sourceUrl": "https://aihubmix.com/api/v1/models"
    },
    "aihubmix/deepseek-v4-pro": {
      "inputUsdPerMillion": 1.69,
      "outputUsdPerMillion": 3.38,
      "cacheReadUsdPerMillion": 0.14027,
      "provider": "aihubmix",
      "sourceUrl": "https://aihubmix.com/api/v1/models"
    },
    "aihubmix/doubao-seed-2-0-code-preview": {
      "inputUsdPerMillion": 0.4822,
      "outputUsdPerMillion": 2.411,
      "cacheReadUsdPerMillion": 0.09644,
      "provider": "aihubmix",
      "sourceUrl": "https://aihubmix.com/api/v1/models"
    },
    "aihubmix/doubao-seed-2-0-lite-260428": {
      "inputUsdPerMillion": 0.09041,
      "outputUsdPerMillion": 0.5424599999999999,
      "cacheReadUsdPerMillion": 0.018082,
      "provider": "aihubmix",
      "sourceUrl": "https://aihubmix.com/api/v1/models"
    },
    "aihubmix/doubao-seed-2-0-mini": {
      "inputUsdPerMillion": 0.030136,
      "outputUsdPerMillion": 0.30136,
      "cacheReadUsdPerMillion": 0.006027,
      "provider": "aihubmix",
      "sourceUrl": "https://aihubmix.com/api/v1/models"
    },
    "aihubmix/doubao-seed-2-0-pro": {
      "inputUsdPerMillion": 0.4822,
      "outputUsdPerMillion": 2.411,
      "cacheReadUsdPerMillion": 0.09644,
      "provider": "aihubmix",
      "sourceUrl": "https://aihubmix.com/api/v1/models"
    },
    "aihubmix/doubao-seed-2-1-turbo": {
      "inputUsdPerMillion": 0.46475,
      "outputUsdPerMillion": 2.32375,
      "cacheReadUsdPerMillion": 0.09294999999999999,
      "provider": "aihubmix",
      "sourceUrl": "https://aihubmix.com/api/v1/models"
    },
    "aihubmix/ernie-5.1": {
      "inputUsdPerMillion": 0.5634,
      "outputUsdPerMillion": 2.5353,
      "cacheReadUsdPerMillion": 0.5634,
      "provider": "aihubmix",
      "sourceUrl": "https://aihubmix.com/api/v1/models"
    },
    "aihubmix/gemini-3-flash-preview": {
      "inputUsdPerMillion": 0.5,
      "outputUsdPerMillion": 3,
      "cacheReadUsdPerMillion": 0.049999999999999996,
      "provider": "aihubmix",
      "sourceUrl": "https://aihubmix.com/api/v1/models"
    },
    "aihubmix/gemini-3-flash-preview-search": {
      "inputUsdPerMillion": 0.5,
      "outputUsdPerMillion": 3,
      "cacheReadUsdPerMillion": 0.049999999999999996,
      "provider": "aihubmix",
      "sourceUrl": "https://aihubmix.com/api/v1/models"
    },
    "aihubmix/gemini-3.1-pro-preview": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 12,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "provider": "aihubmix",
      "sourceUrl": "https://aihubmix.com/api/v1/models"
    },
    "aihubmix/gemini-3.1-pro-preview-customtools": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 12,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "provider": "aihubmix",
      "sourceUrl": "https://aihubmix.com/api/v1/models"
    },
    "aihubmix/gemini-3.5-flash-lite": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 2.499999,
      "cacheReadUsdPerMillion": 0.03,
      "provider": "aihubmix",
      "sourceUrl": "https://aihubmix.com/api/v1/models"
    },
    "aihubmix/gemini-3.7-flash": {
      "inputUsdPerMillion": 0.75,
      "outputUsdPerMillion": 3.75,
      "cacheReadUsdPerMillion": 0.075,
      "provider": "aihubmix",
      "sourceUrl": "https://aihubmix.com/api/v1/models"
    },
    "aihubmix/gemma-4-26b-a4b-it": {
      "inputUsdPerMillion": 0.14,
      "outputUsdPerMillion": 0.39998,
      "provider": "aihubmix",
      "sourceUrl": "https://aihubmix.com/api/v1/models"
    },
    "aihubmix/gemma-4-31b-it": {
      "inputUsdPerMillion": 0.14,
      "outputUsdPerMillion": 0.39998,
      "provider": "aihubmix",
      "sourceUrl": "https://aihubmix.com/api/v1/models"
    },
    "aihubmix/glm-5.2-fast-preview": {
      "inputUsdPerMillion": 2.254,
      "outputUsdPerMillion": 7.889,
      "cacheReadUsdPerMillion": 0.5635,
      "provider": "aihubmix",
      "sourceUrl": "https://aihubmix.com/api/v1/models"
    },
    "aihubmix/glm-5.3": {
      "inputUsdPerMillion": 1.1268,
      "outputUsdPerMillion": 3.9438000000000004,
      "cacheReadUsdPerMillion": 0.2817,
      "provider": "aihubmix",
      "sourceUrl": "https://aihubmix.com/api/v1/models"
    },
    "aihubmix/glm-5.3-flash": {
      "inputUsdPerMillion": 0.11268,
      "outputUsdPerMillion": 0.39438,
      "cacheReadUsdPerMillion": 0.02817,
      "provider": "aihubmix",
      "sourceUrl": "https://aihubmix.com/api/v1/models"
    },
    "aihubmix/glm-5v-turbo": {
      "inputUsdPerMillion": 0.7041999999999999,
      "outputUsdPerMillion": 3.09848,
      "cacheReadUsdPerMillion": 0.169008,
      "provider": "aihubmix",
      "sourceUrl": "https://aihubmix.com/api/v1/models"
    },
    "aihubmix/gpt-5.3-codex": {
      "inputUsdPerMillion": 1.75,
      "outputUsdPerMillion": 14,
      "cacheReadUsdPerMillion": 0.175,
      "provider": "aihubmix",
      "sourceUrl": "https://aihubmix.com/api/v1/models"
    },
    "aihubmix/gpt-5.4-high": {
      "inputUsdPerMillion": 2.5,
      "outputUsdPerMillion": 15,
      "cacheReadUsdPerMillion": 0.25,
      "provider": "aihubmix",
      "sourceUrl": "https://aihubmix.com/api/v1/models"
    },
    "aihubmix/gpt-5.4-low": {
      "inputUsdPerMillion": 2.5,
      "outputUsdPerMillion": 15,
      "cacheReadUsdPerMillion": 0.25,
      "provider": "aihubmix",
      "sourceUrl": "https://aihubmix.com/api/v1/models"
    },
    "aihubmix/gpt-5.4-mini": {
      "inputUsdPerMillion": 0.75,
      "outputUsdPerMillion": 4.5,
      "cacheReadUsdPerMillion": 0.075,
      "provider": "aihubmix",
      "sourceUrl": "https://aihubmix.com/api/v1/models"
    },
    "aihubmix/gpt-5.4-nano": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 1.25,
      "cacheReadUsdPerMillion": 0.02,
      "provider": "aihubmix",
      "sourceUrl": "https://aihubmix.com/api/v1/models"
    },
    "aihubmix/gpt-5.5": {
      "inputUsdPerMillion": 5,
      "outputUsdPerMillion": 30,
      "cacheReadUsdPerMillion": 0.5,
      "provider": "aihubmix",
      "sourceUrl": "https://aihubmix.com/api/v1/models"
    },
    "aihubmix/gpt-5.5-pro": {
      "inputUsdPerMillion": 30,
      "outputUsdPerMillion": 180,
      "provider": "aihubmix",
      "sourceUrl": "https://aihubmix.com/api/v1/models"
    },
    "aihubmix/gpt-5.6-luna": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 1.2,
      "cacheReadUsdPerMillion": 0.02,
      "cacheWriteUsdPerMillion": 0.25,
      "provider": "aihubmix",
      "sourceUrl": "https://aihubmix.com/api/v1/models"
    },
    "aihubmix/gpt-5.6-sol-disc": {
      "inputUsdPerMillion": 4,
      "outputUsdPerMillion": 20,
      "cacheReadUsdPerMillion": 0.39999999999999997,
      "cacheWriteUsdPerMillion": 5,
      "provider": "aihubmix",
      "sourceUrl": "https://aihubmix.com/api/v1/models"
    },
    "aihubmix/gpt-5.6-terra": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 12,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "cacheWriteUsdPerMillion": 2.5,
      "provider": "aihubmix",
      "sourceUrl": "https://aihubmix.com/api/v1/models"
    },
    "aihubmix/gpt-chat-latest": {
      "inputUsdPerMillion": 5,
      "outputUsdPerMillion": 30,
      "cacheReadUsdPerMillion": 0.5,
      "provider": "aihubmix",
      "sourceUrl": "https://aihubmix.com/api/v1/models"
    },
    "aihubmix/grok-4-20-non-reasoning": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 6,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "provider": "aihubmix",
      "sourceUrl": "https://aihubmix.com/api/v1/models"
    },
    "aihubmix/grok-4-20-reasoning": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 6,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "provider": "aihubmix",
      "sourceUrl": "https://aihubmix.com/api/v1/models"
    },
    "aihubmix/grok-4.6": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 6,
      "cacheReadUsdPerMillion": 0.5,
      "provider": "aihubmix",
      "sourceUrl": "https://aihubmix.com/api/v1/models"
    },
    "aihubmix/grok-build-0.1": {
      "inputUsdPerMillion": 1,
      "outputUsdPerMillion": 2,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "provider": "aihubmix",
      "sourceUrl": "https://aihubmix.com/api/v1/models"
    },
    "aihubmix/hy3": {
      "inputUsdPerMillion": 0.1562,
      "outputUsdPerMillion": 0.6248,
      "cacheReadUsdPerMillion": 0.03905,
      "provider": "aihubmix",
      "sourceUrl": "https://aihubmix.com/api/v1/models"
    },
    "aihubmix/hy4-preview": {
      "inputUsdPerMillion": 0.845,
      "outputUsdPerMillion": 2.5349999999999997,
      "cacheReadUsdPerMillion": 0.042249999999999996,
      "provider": "aihubmix",
      "sourceUrl": "https://aihubmix.com/api/v1/models"
    },
    "aihubmix/kimi-k2.6": {
      "inputUsdPerMillion": 0.95,
      "outputUsdPerMillion": 3.9995000000000003,
      "cacheReadUsdPerMillion": 0.160835,
      "provider": "aihubmix",
      "sourceUrl": "https://aihubmix.com/api/v1/models"
    },
    "aihubmix/kimi-k2.7-code-highspeed": {
      "inputUsdPerMillion": 1.9,
      "outputUsdPerMillion": 7.9990000000000006,
      "cacheReadUsdPerMillion": 0.32167,
      "provider": "aihubmix",
      "sourceUrl": "https://aihubmix.com/api/v1/models"
    },
    "aihubmix/kimi-k3": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 15,
      "cacheReadUsdPerMillion": 0.3,
      "provider": "aihubmix",
      "sourceUrl": "https://aihubmix.com/api/v1/models"
    },
    "aihubmix/longcat-2.0": {
      "inputUsdPerMillion": 0.7746,
      "outputUsdPerMillion": 3.0984,
      "cacheReadUsdPerMillion": 0.015492,
      "provider": "aihubmix",
      "sourceUrl": "https://aihubmix.com/api/v1/models"
    },
    "aihubmix/mai-thinking-1": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 8,
      "provider": "aihubmix",
      "sourceUrl": "https://aihubmix.com/api/v1/models"
    },
    "aihubmix/mimo-v2-omni": {
      "inputUsdPerMillion": 0.44,
      "outputUsdPerMillion": 2.2,
      "cacheReadUsdPerMillion": 0.088,
      "provider": "aihubmix",
      "sourceUrl": "https://aihubmix.com/api/v1/models"
    },
    "aihubmix/mimo-v2-pro": {
      "inputUsdPerMillion": 1.1,
      "outputUsdPerMillion": 3.3000000000000003,
      "cacheReadUsdPerMillion": 0.22,
      "provider": "aihubmix",
      "sourceUrl": "https://aihubmix.com/api/v1/models"
    },
    "aihubmix/minimax-m2.7": {
      "inputUsdPerMillion": 0.2958,
      "outputUsdPerMillion": 1.1832,
      "cacheReadUsdPerMillion": 0.059160000000000004,
      "provider": "aihubmix",
      "sourceUrl": "https://aihubmix.com/api/v1/models"
    },
    "aihubmix/minimax-m3": {
      "inputUsdPerMillion": 0.288,
      "outputUsdPerMillion": 1.152,
      "provider": "aihubmix",
      "sourceUrl": "https://aihubmix.com/api/v1/models"
    },
    "aihubmix/muse-spark-1.2": {
      "inputUsdPerMillion": 1.375,
      "outputUsdPerMillion": 4.675,
      "provider": "aihubmix",
      "sourceUrl": "https://aihubmix.com/api/v1/models"
    },
    "aihubmix/qwen3-coder-next": {
      "inputUsdPerMillion": 0.13699999999999998,
      "outputUsdPerMillion": 0.5479999999999999,
      "provider": "aihubmix",
      "sourceUrl": "https://aihubmix.com/api/v1/models"
    },
    "aihubmix/qwen3.5-122b-a10b": {
      "inputUsdPerMillion": 0.1126,
      "outputUsdPerMillion": 0.9008,
      "provider": "aihubmix",
      "sourceUrl": "https://aihubmix.com/api/v1/models"
    },
    "aihubmix/qwen3.5-397b-a17b": {
      "inputUsdPerMillion": 0.1644,
      "outputUsdPerMillion": 0.9863999999999999,
      "provider": "aihubmix",
      "sourceUrl": "https://aihubmix.com/api/v1/models"
    },
    "aihubmix/qwen3.6-27b": {
      "inputUsdPerMillion": 0.422,
      "outputUsdPerMillion": 2.532,
      "provider": "aihubmix",
      "sourceUrl": "https://aihubmix.com/api/v1/models"
    },
    "aihubmix/qwen3.6-35b-a3b": {
      "inputUsdPerMillion": 0.254,
      "outputUsdPerMillion": 1.524,
      "provider": "aihubmix",
      "sourceUrl": "https://aihubmix.com/api/v1/models"
    },
    "aihubmix/qwen3.6-max-preview": {
      "inputUsdPerMillion": 1.268,
      "outputUsdPerMillion": 7.608,
      "cacheReadUsdPerMillion": 0.1268,
      "cacheWriteUsdPerMillion": 1.585,
      "provider": "aihubmix",
      "sourceUrl": "https://aihubmix.com/api/v1/models"
    },
    "aihubmix/qwen3.7-plus": {
      "inputUsdPerMillion": 0.28200000000000003,
      "outputUsdPerMillion": 1.1280000000000001,
      "cacheReadUsdPerMillion": 0.0564,
      "cacheWriteUsdPerMillion": 0.35250000000000004,
      "provider": "aihubmix",
      "sourceUrl": "https://aihubmix.com/api/v1/models"
    },
    "aihubmix/qwen3.8-2.4t-a95b": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 6,
      "cacheReadUsdPerMillion": 0.5,
      "provider": "aihubmix",
      "sourceUrl": "https://aihubmix.com/api/v1/models"
    },
    "aihubmix/qwen3.8-flash": {
      "inputUsdPerMillion": 0.1126,
      "outputUsdPerMillion": 0.380025,
      "cacheReadUsdPerMillion": 0.014075,
      "cacheWriteUsdPerMillion": 0.17593699999999998,
      "provider": "aihubmix",
      "sourceUrl": "https://aihubmix.com/api/v1/models"
    },
    "aihubmix/qwen3.8-max": {
      "inputUsdPerMillion": 1.69,
      "outputUsdPerMillion": 5.069999999999999,
      "cacheReadUsdPerMillion": 0.16899999999999998,
      "cacheWriteUsdPerMillion": 2.1125000000000003,
      "provider": "aihubmix",
      "sourceUrl": "https://aihubmix.com/api/v1/models"
    },
    "aihubmix/step-3.7-flash": {
      "inputUsdPerMillion": 0.22,
      "outputUsdPerMillion": 1.32,
      "cacheReadUsdPerMillion": 0.044,
      "provider": "aihubmix",
      "sourceUrl": "https://aihubmix.com/api/v1/models"
    },
    "wandb/deepseek-ai/DeepSeek-V4.1-Flash": {
      "inputUsdPerMillion": 0.19999999999999998,
      "outputUsdPerMillion": 0.65,
      "cacheReadUsdPerMillion": 0.03,
      "provider": "wandb",
      "sourceUrl": "https://wandb.ai/site/pricing/tokens/"
    },
    "wandb/google/gemma-4-26B-A4B-it": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.3,
      "cacheReadUsdPerMillion": 0.049999999999999996,
      "provider": "wandb",
      "sourceUrl": "https://wandb.ai/site/pricing/tokens/"
    },
    "wandb/zai-org/GLM-5.3-Flash": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.5,
      "cacheReadUsdPerMillion": 0.049999999999999996,
      "provider": "wandb",
      "sourceUrl": "https://docs.wandb.ai/inference/models.md"
    },
    "moonshotai.kimi-k3": {
      "inputUsdPerMillion": 3.3000000000000003,
      "outputUsdPerMillion": 16.5,
      "cacheReadUsdPerMillion": 0.33,
      "cacheWriteUsdPerMillion": 4.125,
      "provider": "bedrock_converse",
      "sourceUrl": "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrock/current/us-east-1/index.json"
    },
    "global.moonshotai.kimi-k3": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 15,
      "cacheReadUsdPerMillion": 0.3,
      "cacheWriteUsdPerMillion": 3.75,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "us.moonshotai.kimi-k3": {
      "inputUsdPerMillion": 3.3000000000000003,
      "outputUsdPerMillion": 16.5,
      "cacheReadUsdPerMillion": 0.33,
      "cacheWriteUsdPerMillion": 4.125,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "xiaomi_mimo/mimo-v2.6-pro": {
      "inputUsdPerMillion": 0.435,
      "outputUsdPerMillion": 0.87,
      "cacheReadUsdPerMillion": 0.0036,
      "provider": "xiaomi_mimo",
      "sourceUrl": "https://platform.xiaomimimo.com/static/docs/price/pay-as-you-go.md"
    },
    "xiaomi_mimo/mimo-v2.6-flash": {
      "inputUsdPerMillion": 0.14,
      "outputUsdPerMillion": 0.28,
      "cacheReadUsdPerMillion": 0.0028,
      "provider": "xiaomi_mimo",
      "sourceUrl": "https://platform.xiaomimimo.com/static/docs/price/pay-as-you-go.md"
    },
    "xai/grok-4.20-0309": {
      "inputUsdPerMillion": 1.25,
      "outputUsdPerMillion": 2.5,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "provider": "xai",
      "sourceUrl": "https://api.x.ai/v1/language-models"
    },
    "xai/grok-4.20-beta": {
      "inputUsdPerMillion": 1.25,
      "outputUsdPerMillion": 2.5,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "provider": "xai",
      "sourceUrl": "https://api.x.ai/v1/language-models"
    },
    "xai/grok-4.20-beta-0309": {
      "inputUsdPerMillion": 1.25,
      "outputUsdPerMillion": 2.5,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "provider": "xai",
      "sourceUrl": "https://api.x.ai/v1/language-models"
    },
    "xai/grok-4.20-beta-latest": {
      "inputUsdPerMillion": 1.25,
      "outputUsdPerMillion": 2.5,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "provider": "xai",
      "sourceUrl": "https://api.x.ai/v1/language-models"
    },
    "xai/grok-4.20-beta-latest-non-reasoning": {
      "inputUsdPerMillion": 1.25,
      "outputUsdPerMillion": 2.5,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "provider": "xai",
      "sourceUrl": "https://api.x.ai/v1/language-models"
    },
    "xai/grok-4.20-beta-latest-reasoning": {
      "inputUsdPerMillion": 1.25,
      "outputUsdPerMillion": 2.5,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "provider": "xai",
      "sourceUrl": "https://api.x.ai/v1/language-models"
    },
    "xai/grok-4.20-beta-non-reasoning": {
      "inputUsdPerMillion": 1.25,
      "outputUsdPerMillion": 2.5,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "provider": "xai",
      "sourceUrl": "https://api.x.ai/v1/language-models"
    },
    "xai/grok-4.20-beta-reasoning": {
      "inputUsdPerMillion": 1.25,
      "outputUsdPerMillion": 2.5,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "provider": "xai",
      "sourceUrl": "https://api.x.ai/v1/language-models"
    },
    "xai/grok-4.20-experimental-beta-0304": {
      "inputUsdPerMillion": 1.25,
      "outputUsdPerMillion": 2.5,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "provider": "xai",
      "sourceUrl": "https://api.x.ai/v1/language-models"
    },
    "xai/grok-4.20-experimental-beta-0304-non-reasoning": {
      "inputUsdPerMillion": 1.25,
      "outputUsdPerMillion": 2.5,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "provider": "xai",
      "sourceUrl": "https://api.x.ai/v1/language-models"
    },
    "xai/grok-4.20-experimental-beta-0304-reasoning": {
      "inputUsdPerMillion": 1.25,
      "outputUsdPerMillion": 2.5,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "provider": "xai",
      "sourceUrl": "https://api.x.ai/v1/language-models"
    },
    "xai/grok-4.20-experimental-beta-latest": {
      "inputUsdPerMillion": 1.25,
      "outputUsdPerMillion": 2.5,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "provider": "xai",
      "sourceUrl": "https://api.x.ai/v1/language-models"
    },
    "xai/grok-4.20-experimental-beta-non-reasoning-latest": {
      "inputUsdPerMillion": 1.25,
      "outputUsdPerMillion": 2.5,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "provider": "xai",
      "sourceUrl": "https://api.x.ai/v1/language-models"
    },
    "xai/grok-4.20-experimental-beta-reasoning-latest": {
      "inputUsdPerMillion": 1.25,
      "outputUsdPerMillion": 2.5,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "provider": "xai",
      "sourceUrl": "https://api.x.ai/v1/language-models"
    },
    "xai/grok-4.20-non-reasoning-gv2": {
      "inputUsdPerMillion": 1.25,
      "outputUsdPerMillion": 2.5,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "provider": "xai",
      "sourceUrl": "https://api.x.ai/v1/language-models"
    },
    "xai/grok-4.20-reasoning-gv2": {
      "inputUsdPerMillion": 1.25,
      "outputUsdPerMillion": 2.5,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "provider": "xai",
      "sourceUrl": "https://api.x.ai/v1/language-models"
    },
    "baseten/deepseek-ai/DeepSeek-V4.1-Flash": {
      "inputUsdPerMillion": 0.3,
      "outputUsdPerMillion": 1.2,
      "cacheReadUsdPerMillion": 0.007,
      "provider": "baseten",
      "sourceUrl": "https://inference.baseten.co/v1/models"
    },
    "baseten/moonshotai/Kimi-K2.6": {
      "inputUsdPerMillion": 0.95,
      "outputUsdPerMillion": 4,
      "cacheReadUsdPerMillion": 0.16,
      "provider": "baseten",
      "sourceUrl": "https://inference.baseten.co/v1/models"
    },
    "baseten/moonshotai/Kimi-K2.7-Code": {
      "inputUsdPerMillion": 0.95,
      "outputUsdPerMillion": 4,
      "cacheReadUsdPerMillion": 0.16,
      "provider": "baseten",
      "sourceUrl": "https://inference.baseten.co/v1/models"
    },
    "baseten/moonshotai/Kimi-K3": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 15,
      "cacheReadUsdPerMillion": 0.3,
      "provider": "baseten",
      "sourceUrl": "https://inference.baseten.co/v1/models"
    },
    "baseten/nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 2.4,
      "cacheReadUsdPerMillion": 0.12,
      "provider": "baseten",
      "sourceUrl": "https://inference.baseten.co/v1/models"
    },
    "baseten/thinkingmachines/inkling": {
      "inputUsdPerMillion": 1,
      "outputUsdPerMillion": 4.05,
      "cacheReadUsdPerMillion": 0.16999999999999998,
      "provider": "baseten",
      "sourceUrl": "https://inference.baseten.co/v1/models"
    },
    "baseten/thinkingmachines/inkling-small": {
      "inputUsdPerMillion": 0.5,
      "outputUsdPerMillion": 1.2,
      "cacheReadUsdPerMillion": 0.09999999999999999,
      "provider": "baseten",
      "sourceUrl": "https://inference.baseten.co/v1/models"
    },
    "baseten/zai-org/GLM-5.2": {
      "inputUsdPerMillion": 1.4,
      "outputUsdPerMillion": 4.4,
      "cacheReadUsdPerMillion": 0.14,
      "provider": "baseten",
      "sourceUrl": "https://inference.baseten.co/v1/models"
    },
    "baseten/zai-org/GLM-5.3-Flash": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.5,
      "cacheReadUsdPerMillion": 0.03,
      "provider": "baseten",
      "sourceUrl": "https://inference.baseten.co/v1/models"
    },
    "baseten/deepseek-ai/DeepSeek-V4-Flash-0731": {
      "inputUsdPerMillion": 0.13,
      "outputUsdPerMillion": 0.26,
      "cacheReadUsdPerMillion": 0.028,
      "provider": "baseten",
      "sourceUrl": "https://inference.baseten.co/v1/models"
    },
    "baseten/deepseek-ai/DeepSeek-V4-Pro": {
      "inputUsdPerMillion": 1.74,
      "outputUsdPerMillion": 3.48,
      "cacheReadUsdPerMillion": 0.145,
      "provider": "baseten",
      "sourceUrl": "https://inference.baseten.co/v1/models"
    },
    "baseten/deepseek-ai/DeepSeek-V4-Pro-0813": {
      "inputUsdPerMillion": 1.32,
      "outputUsdPerMillion": 3.9600000000000004,
      "cacheReadUsdPerMillion": 0.13199999999999998,
      "provider": "baseten",
      "sourceUrl": "https://inference.baseten.co/v1/models"
    },
    "baseten/zai-org/GLM-5.2-Fast": {
      "inputUsdPerMillion": 2.0999999999999996,
      "outputUsdPerMillion": 6.6000000000000005,
      "cacheReadUsdPerMillion": 0.21,
      "provider": "baseten",
      "sourceUrl": "https://inference.baseten.co/v1/models"
    },
    "xai/grok-code-fast": {
      "inputUsdPerMillion": 1,
      "outputUsdPerMillion": 2,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "provider": "xai",
      "sourceUrl": "https://api.x.ai/v1/language-models"
    },
    "xai/grok-code-fast-1": {
      "inputUsdPerMillion": 1,
      "outputUsdPerMillion": 2,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "provider": "xai",
      "sourceUrl": "https://api.x.ai/v1/language-models"
    },
    "xai/grok-code-fast-1-0825": {
      "inputUsdPerMillion": 1,
      "outputUsdPerMillion": 2,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "provider": "xai",
      "sourceUrl": "https://api.x.ai/v1/language-models"
    },
    "fireworks_ai/accounts/fireworks/models/deepseek-v4-pro": {
      "inputUsdPerMillion": 1.2,
      "outputUsdPerMillion": 1.2,
      "cacheReadUsdPerMillion": 0.6,
      "provider": "fireworks_ai",
      "sourceUrl": "https://api.fireworks.ai/v1/serverless/models"
    },
    "fireworks_ai/accounts/fireworks/models/ember-1": {
      "inputUsdPerMillion": 3,
      "outputUsdPerMillion": 15,
      "cacheReadUsdPerMillion": 0.3,
      "provider": "fireworks_ai",
      "sourceUrl": "https://api.fireworks.ai/v1/serverless/models"
    },
    "vertex_ai/gemini-2.0-flash": {
      "inputUsdPerMillion": 0.15,
      "outputUsdPerMillion": 0.6,
      "provider": "vertex_ai",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "vertex_ai/gemini-2.0-flash-lite": {
      "inputUsdPerMillion": 0.075,
      "outputUsdPerMillion": 0.3,
      "provider": "vertex_ai",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "vertex_ai/zai-org/glm-5.2-maas": {
      "inputUsdPerMillion": 1.4,
      "outputUsdPerMillion": 4.4,
      "cacheReadUsdPerMillion": 0.14,
      "provider": "vertex_ai-zai_models",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "vertex_ai/meta/llama-3.3-70b-instruct-maas": {
      "inputUsdPerMillion": 0.72,
      "outputUsdPerMillion": 0.72,
      "provider": "vertex_ai-llama_models",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "anthropic.claude-mythos-5-1": {
      "inputUsdPerMillion": 10,
      "outputUsdPerMillion": 50,
      "cacheReadUsdPerMillion": 0.25,
      "cacheWriteUsdPerMillion": 12.5,
      "provider": "bedrock_converse",
      "sourceUrl": "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrockFoundationModels/current/index.json"
    },
    "global.anthropic.claude-mythos-5-1": {
      "inputUsdPerMillion": 10,
      "outputUsdPerMillion": 50,
      "cacheReadUsdPerMillion": 0.25,
      "cacheWriteUsdPerMillion": 12.5,
      "provider": "bedrock_converse",
      "sourceUrl": "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrockFoundationModels/current/index.json"
    },
    "us.anthropic.claude-mythos-5-1": {
      "inputUsdPerMillion": 11,
      "outputUsdPerMillion": 55,
      "cacheReadUsdPerMillion": 0.275,
      "cacheWriteUsdPerMillion": 13.75,
      "provider": "bedrock_converse",
      "sourceUrl": "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrockFoundationModels/current/index.json"
    },
    "us.anthropic.claude-mythos-5": {
      "inputUsdPerMillion": 11,
      "outputUsdPerMillion": 55,
      "cacheReadUsdPerMillion": 1.1,
      "cacheWriteUsdPerMillion": 13.75,
      "provider": "bedrock_converse",
      "sourceUrl": "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrockFoundationModels/current/index.json"
    },
    "apac.anthropic.claude-fable-5": {
      "inputUsdPerMillion": 11,
      "outputUsdPerMillion": 55,
      "cacheReadUsdPerMillion": 1.1,
      "cacheWriteUsdPerMillion": 13.75,
      "provider": "bedrock_converse",
      "sourceUrl": "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrockFoundationModels/current/index.json"
    },
    "au.anthropic.claude-fable-5": {
      "inputUsdPerMillion": 11,
      "outputUsdPerMillion": 55,
      "cacheReadUsdPerMillion": 1.1,
      "cacheWriteUsdPerMillion": 13.75,
      "provider": "bedrock_converse",
      "sourceUrl": "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrockFoundationModels/current/index.json"
    },
    "apac.anthropic.claude-opus-4-7": {
      "inputUsdPerMillion": 5.5,
      "outputUsdPerMillion": 27.5,
      "cacheReadUsdPerMillion": 0.55,
      "cacheWriteUsdPerMillion": 6.875,
      "provider": "bedrock_converse",
      "sourceUrl": "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrockFoundationModels/current/index.json"
    },
    "apac.anthropic.claude-opus-4-8": {
      "inputUsdPerMillion": 5.5,
      "outputUsdPerMillion": 27.5,
      "cacheReadUsdPerMillion": 0.55,
      "cacheWriteUsdPerMillion": 6.875,
      "provider": "bedrock_converse",
      "sourceUrl": "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrockFoundationModels/current/index.json"
    },
    "apac.anthropic.claude-opus-5": {
      "inputUsdPerMillion": 5.5,
      "outputUsdPerMillion": 27.5,
      "cacheReadUsdPerMillion": 0.55,
      "cacheWriteUsdPerMillion": 6.875,
      "provider": "bedrock_converse",
      "sourceUrl": "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrockFoundationModels/current/index.json"
    },
    "apac.anthropic.claude-opus-5-5": {
      "inputUsdPerMillion": 4.4,
      "outputUsdPerMillion": 22,
      "cacheReadUsdPerMillion": 0.22,
      "cacheWriteUsdPerMillion": 5.5,
      "provider": "bedrock_converse",
      "sourceUrl": "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrockFoundationModels/current/index.json"
    },
    "apac.anthropic.claude-sonnet-4-6": {
      "inputUsdPerMillion": 3.3000000000000003,
      "outputUsdPerMillion": 16.5,
      "cacheReadUsdPerMillion": 0.33,
      "cacheWriteUsdPerMillion": 4.125,
      "provider": "bedrock_converse",
      "sourceUrl": "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrockFoundationModels/current/index.json"
    },
    "apac.anthropic.claude-sonnet-5": {
      "inputUsdPerMillion": 2.2,
      "outputUsdPerMillion": 11,
      "cacheReadUsdPerMillion": 0.22,
      "cacheWriteUsdPerMillion": 2.75,
      "provider": "bedrock_converse",
      "sourceUrl": "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrockFoundationModels/current/index.json"
    },
    "us.anthropic.claude-mythos-preview": {
      "inputUsdPerMillion": 27.5,
      "outputUsdPerMillion": 137.5,
      "cacheReadUsdPerMillion": 2.75,
      "cacheWriteUsdPerMillion": 34.375,
      "provider": "bedrock_converse",
      "sourceUrl": "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrockFoundationModels/current/index.json"
    },
    "apac.anthropic.claude-mythos-preview": {
      "inputUsdPerMillion": 27.5,
      "outputUsdPerMillion": 137.5,
      "cacheReadUsdPerMillion": 2.75,
      "cacheWriteUsdPerMillion": 34.375,
      "provider": "bedrock_converse",
      "sourceUrl": "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrockFoundationModels/current/index.json"
    },
    "au.anthropic.claude-mythos-preview": {
      "inputUsdPerMillion": 27.5,
      "outputUsdPerMillion": 137.5,
      "cacheReadUsdPerMillion": 2.75,
      "cacheWriteUsdPerMillion": 34.375,
      "provider": "bedrock_converse",
      "sourceUrl": "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrockFoundationModels/current/index.json"
    },
    "deepseek.r1-v1:0": {
      "inputUsdPerMillion": 1.35,
      "outputUsdPerMillion": 5.4,
      "provider": "bedrock_converse",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-deepseek-deepseek-r1.html"
    },
    "mistral.pixtral-large-2502-v1:0": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 6,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "azure_ai/MAI-Cyber-1-Flash": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 3.5,
      "cacheReadUsdPerMillion": 0.06,
      "provider": "azure_ai",
      "sourceUrl": "https://azure.microsoft.com/en-us/pricing/details/ai-foundry-models/microsoft/"
    },
    "anthropic.claude-sonnet-5-5": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 10,
      "cacheReadUsdPerMillion": 0.09999999999999999,
      "cacheWriteUsdPerMillion": 2.5,
      "provider": "bedrock_converse",
      "sourceUrl": "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrockFoundationModels/current/index.json"
    },
    "apac.anthropic.claude-sonnet-5-5": {
      "inputUsdPerMillion": 2.2,
      "outputUsdPerMillion": 11,
      "cacheReadUsdPerMillion": 0.11,
      "cacheWriteUsdPerMillion": 2.75,
      "provider": "bedrock_converse",
      "sourceUrl": "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrockFoundationModels/current/index.json"
    },
    "au.anthropic.claude-sonnet-5-5": {
      "inputUsdPerMillion": 2.2,
      "outputUsdPerMillion": 11,
      "cacheReadUsdPerMillion": 0.11,
      "cacheWriteUsdPerMillion": 2.75,
      "provider": "bedrock_converse",
      "sourceUrl": "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrockFoundationModels/current/index.json"
    },
    "azure_ai/claude-sonnet-5-5": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 10,
      "cacheReadUsdPerMillion": 0.19999999999999998,
      "cacheWriteUsdPerMillion": 2.5,
      "provider": "azure_ai",
      "sourceUrl": "https://management.azure.com/subscriptions/c873328e-b572-4770-8dff-aaeb6f1f0e79/providers/Microsoft.CognitiveServices/locations/eastus2/models?api-version=2024-10-01"
    },
    "bedrock/us-gov-east-1/anthropic.claude-sonnet-5-5": {
      "inputUsdPerMillion": 2.4,
      "outputUsdPerMillion": 12,
      "cacheReadUsdPerMillion": 0.12,
      "cacheWriteUsdPerMillion": 3,
      "provider": "bedrock",
      "sourceUrl": "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrockFoundationModels/current/index.json"
    },
    "bedrock/us-gov-west-1/anthropic.claude-sonnet-5-5": {
      "inputUsdPerMillion": 2.4,
      "outputUsdPerMillion": 12,
      "cacheReadUsdPerMillion": 0.12,
      "cacheWriteUsdPerMillion": 3,
      "provider": "bedrock",
      "sourceUrl": "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrockFoundationModels/current/index.json"
    },
    "eu.anthropic.claude-sonnet-5-5": {
      "inputUsdPerMillion": 2.2,
      "outputUsdPerMillion": 11,
      "cacheReadUsdPerMillion": 0.11,
      "cacheWriteUsdPerMillion": 2.75,
      "provider": "bedrock_converse",
      "sourceUrl": "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrockFoundationModels/current/index.json"
    },
    "global.anthropic.claude-sonnet-5-5": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 10,
      "cacheReadUsdPerMillion": 0.09999999999999999,
      "cacheWriteUsdPerMillion": 2.5,
      "provider": "bedrock_converse",
      "sourceUrl": "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrockFoundationModels/current/index.json"
    },
    "jp.anthropic.claude-sonnet-5-5": {
      "inputUsdPerMillion": 2.2,
      "outputUsdPerMillion": 11,
      "cacheReadUsdPerMillion": 0.11,
      "cacheWriteUsdPerMillion": 2.75,
      "provider": "bedrock_converse",
      "sourceUrl": "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrockFoundationModels/current/index.json"
    },
    "us-gov.anthropic.claude-sonnet-5-5": {
      "inputUsdPerMillion": 2.4,
      "outputUsdPerMillion": 12,
      "cacheReadUsdPerMillion": 0.12,
      "cacheWriteUsdPerMillion": 3,
      "provider": "bedrock_converse",
      "sourceUrl": "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrockFoundationModels/current/index.json"
    },
    "us.anthropic.claude-sonnet-5-5": {
      "inputUsdPerMillion": 2.2,
      "outputUsdPerMillion": 11,
      "cacheReadUsdPerMillion": 0.11,
      "cacheWriteUsdPerMillion": 2.75,
      "provider": "bedrock_converse",
      "sourceUrl": "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrockFoundationModels/current/index.json"
    },
    "vertex_ai/claude-sonnet-5-5": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 10,
      "cacheReadUsdPerMillion": 0.09999999999999999,
      "cacheWriteUsdPerMillion": 2.5,
      "provider": "vertex_ai-anthropic_models",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "vertex_ai/claude-sonnet-5-5@default": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 10,
      "cacheReadUsdPerMillion": 0.09999999999999999,
      "cacheWriteUsdPerMillion": 2.5,
      "provider": "vertex_ai-anthropic_models",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "prism/deepseek-v4.1-flash": {
      "inputUsdPerMillion": 0.16999999999999998,
      "outputUsdPerMillion": 0.63,
      "cacheReadUsdPerMillion": 0.07,
      "provider": "prism",
      "sourceUrl": "https://prisminference.com/pricing"
    },
    "prism/deepseek-v4-flash": {
      "inputUsdPerMillion": 0.16999999999999998,
      "outputUsdPerMillion": 0.21,
      "cacheReadUsdPerMillion": 0.07,
      "provider": "prism",
      "sourceUrl": "https://prisminference.com/pricing"
    },
    "global.xai.grok-4.7": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 6,
      "cacheReadUsdPerMillion": 0.5,
      "provider": "bedrock_converse",
      "sourceUrl": "https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/bedrock/USD/current/bedrock.json"
    },
    "us.xai.grok-4.7": {
      "inputUsdPerMillion": 2.2,
      "outputUsdPerMillion": 6.6000000000000005,
      "cacheReadUsdPerMillion": 0.55,
      "provider": "bedrock_converse",
      "sourceUrl": "https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/bedrock/USD/current/bedrock.json"
    },
    "baseten/deepseek-ai/DeepSeek-V4.1-Flash-Fast": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 2.4,
      "cacheReadUsdPerMillion": 0.014,
      "provider": "baseten",
      "sourceUrl": "https://inference.baseten.co/v1/models"
    },
    "gpt-6.1-sol": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 10,
      "cacheReadUsdPerMillion": 0.09999999999999999,
      "cacheWriteUsdPerMillion": 2.5,
      "provider": "openai",
      "sourceUrl": "https://developers.openai.com/api/docs/pricing"
    },
    "global.openai.gpt-6.1-sol": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 10,
      "cacheReadUsdPerMillion": 0.09999999999999999,
      "cacheWriteUsdPerMillion": 2.5,
      "provider": "bedrock_converse",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-6-1-sol.html"
    },
    "us.openai.gpt-6.1-sol": {
      "inputUsdPerMillion": 2.2,
      "outputUsdPerMillion": 11,
      "cacheReadUsdPerMillion": 0.11,
      "cacheWriteUsdPerMillion": 2.75,
      "provider": "bedrock_converse",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-6-1-sol.html"
    },
    "vertex_ai/xai/grok-4.7": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 6,
      "cacheReadUsdPerMillion": 0.5,
      "provider": "vertex_ai",
      "sourceUrl": "https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing"
    },
    "azure_ai/kimi-k2-thinking": {
      "inputUsdPerMillion": 0.6,
      "outputUsdPerMillion": 2.5,
      "provider": "azure_ai",
      "sourceUrl": "https://azure.microsoft.com/en-us/pricing/details/ai-foundry-models/kimi/"
    },
    "global.zai.glm-5.3": {
      "inputUsdPerMillion": 1.68,
      "outputUsdPerMillion": 5.28,
      "cacheReadUsdPerMillion": 0.312,
      "cacheWriteUsdPerMillion": 2.0999999999999996,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "us.zai.glm-5.3": {
      "inputUsdPerMillion": 1.8479999999999999,
      "outputUsdPerMillion": 5.808,
      "cacheReadUsdPerMillion": 0.3432,
      "cacheWriteUsdPerMillion": 2.31,
      "provider": "bedrock_converse",
      "sourceUrl": "https://aws.amazon.com/bedrock/pricing/"
    },
    "azure/model-router": {
      "inputUsdPerMillion": 0.14,
      "outputUsdPerMillion": 0,
      "provider": "azure",
      "sourceUrl": "https://azure.microsoft.com/en-us/pricing/details/ai-foundry-models/model-router/"
    },
    "azure_ai/grok-4.7": {
      "inputUsdPerMillion": 2,
      "outputUsdPerMillion": 6,
      "cacheReadUsdPerMillion": 0.5,
      "provider": "azure_ai",
      "sourceUrl": "https://docs.x.ai/developers/models/grok-4.7"
    },
    "in.moonshotai.kimi-k3": {
      "inputUsdPerMillion": 3.3000000000000003,
      "outputUsdPerMillion": 16.5,
      "cacheReadUsdPerMillion": 0.33,
      "cacheWriteUsdPerMillion": 4.125,
      "provider": "bedrock_converse",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-moonshot-ai-kimi-k3.md"
    },
    "claude-haiku-5-5": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.5,
      "cacheReadUsdPerMillion": 0.01,
      "cacheWriteUsdPerMillion": 0.125,
      "provider": "anthropic",
      "sourceUrl": "https://platform.claude.com/docs/en/models/haiku-5-5/overview"
    },
    "bedrock_mantle/anthropic.claude-haiku-5-5": {
      "inputUsdPerMillion": 0.11,
      "outputUsdPerMillion": 0.55,
      "cacheReadUsdPerMillion": 0.011,
      "cacheWriteUsdPerMillion": 0.1375,
      "provider": "bedrock_mantle",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-haiku-5-5.html"
    },
    "bedrock_mantle/us-gov-west-1/anthropic.claude-haiku-5-5": {
      "inputUsdPerMillion": 0.12,
      "outputUsdPerMillion": 0.6,
      "cacheReadUsdPerMillion": 0.012,
      "cacheWriteUsdPerMillion": 0.15,
      "provider": "bedrock_mantle",
      "sourceUrl": "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-haiku-5-5.html"
    },
    "anthropic.claude-haiku-5-5": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.5,
      "cacheReadUsdPerMillion": 0.01,
      "cacheWriteUsdPerMillion": 0.125,
      "provider": "bedrock_converse",
      "sourceUrl": "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrockFoundationModels/current/index.json"
    },
    "apac.anthropic.claude-haiku-5-5": {
      "inputUsdPerMillion": 0.11,
      "outputUsdPerMillion": 0.55,
      "cacheReadUsdPerMillion": 0.011,
      "cacheWriteUsdPerMillion": 0.1375,
      "provider": "bedrock_converse",
      "sourceUrl": "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrockFoundationModels/current/index.json"
    },
    "au.anthropic.claude-haiku-5-5": {
      "inputUsdPerMillion": 0.11,
      "outputUsdPerMillion": 0.55,
      "cacheReadUsdPerMillion": 0.011,
      "cacheWriteUsdPerMillion": 0.1375,
      "provider": "bedrock_converse",
      "sourceUrl": "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrockFoundationModels/current/index.json"
    },
    "azure_ai/claude-haiku-5-5": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.5,
      "cacheReadUsdPerMillion": 0.01,
      "cacheWriteUsdPerMillion": 0.125,
      "provider": "azure_ai",
      "sourceUrl": "https://platform.claude.com/docs/en/models/haiku-5-5/migration-guide"
    },
    "bedrock/us-gov-east-1/anthropic.claude-haiku-5-5": {
      "inputUsdPerMillion": 0.12,
      "outputUsdPerMillion": 0.6,
      "cacheReadUsdPerMillion": 0.012,
      "cacheWriteUsdPerMillion": 0.15,
      "provider": "bedrock",
      "sourceUrl": "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrockFoundationModels/current/index.json"
    },
    "bedrock/us-gov-west-1/anthropic.claude-haiku-5-5": {
      "inputUsdPerMillion": 0.12,
      "outputUsdPerMillion": 0.6,
      "cacheReadUsdPerMillion": 0.012,
      "cacheWriteUsdPerMillion": 0.15,
      "provider": "bedrock",
      "sourceUrl": "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrockFoundationModels/current/index.json"
    },
    "eu.anthropic.claude-haiku-5-5": {
      "inputUsdPerMillion": 0.11,
      "outputUsdPerMillion": 0.55,
      "cacheReadUsdPerMillion": 0.011,
      "cacheWriteUsdPerMillion": 0.1375,
      "provider": "bedrock_converse",
      "sourceUrl": "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrockFoundationModels/current/index.json"
    },
    "global.anthropic.claude-haiku-5-5": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.5,
      "cacheReadUsdPerMillion": 0.01,
      "cacheWriteUsdPerMillion": 0.125,
      "provider": "bedrock_converse",
      "sourceUrl": "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrockFoundationModels/current/index.json"
    },
    "jp.anthropic.claude-haiku-5-5": {
      "inputUsdPerMillion": 0.11,
      "outputUsdPerMillion": 0.55,
      "cacheReadUsdPerMillion": 0.011,
      "cacheWriteUsdPerMillion": 0.1375,
      "provider": "bedrock_converse",
      "sourceUrl": "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrockFoundationModels/current/index.json"
    },
    "us-gov.anthropic.claude-haiku-5-5": {
      "inputUsdPerMillion": 0.12,
      "outputUsdPerMillion": 0.6,
      "cacheReadUsdPerMillion": 0.012,
      "cacheWriteUsdPerMillion": 0.15,
      "provider": "bedrock_converse",
      "sourceUrl": "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrockFoundationModels/current/index.json"
    },
    "us.anthropic.claude-haiku-5-5": {
      "inputUsdPerMillion": 0.11,
      "outputUsdPerMillion": 0.55,
      "cacheReadUsdPerMillion": 0.011,
      "cacheWriteUsdPerMillion": 0.1375,
      "provider": "bedrock_converse",
      "sourceUrl": "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrockFoundationModels/current/index.json"
    },
    "vertex_ai/claude-haiku-5-5": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.5,
      "cacheReadUsdPerMillion": 0.01,
      "cacheWriteUsdPerMillion": 0.125,
      "provider": "vertex_ai-anthropic_models",
      "sourceUrl": "https://cloud.google.com/vertex-ai/generative-ai/pricing"
    },
    "vertex_ai/claude-haiku-5-5@default": {
      "inputUsdPerMillion": 0.09999999999999999,
      "outputUsdPerMillion": 0.5,
      "cacheReadUsdPerMillion": 0.01,
      "cacheWriteUsdPerMillion": 0.125,
      "provider": "vertex_ai-anthropic_models",
      "sourceUrl": "https://cloud.google.com/vertex-ai/generative-ai/pricing"
    },
    "microsoft_365_copilot/chat": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0,
      "provider": "microsoft_365_copilot"
    },
    "gpt-rosalind-discovery": {
      "inputUsdPerMillion": 5,
      "outputUsdPerMillion": 25,
      "cacheReadUsdPerMillion": 0.5,
      "provider": "openai",
      "sourceUrl": "https://developers.openai.com/api/docs/pricing"
    }
  },
  "provenance": {
    "source": "litellm",
    "origin": "bundled",
    "asOfMs": 1791617374000,
    "revision": "729b02d05719715f4faeb1f81ef2728ef06c3273",
    "fetchStatus": "ready"
  }
} as const;

