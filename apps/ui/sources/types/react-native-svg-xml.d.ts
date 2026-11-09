// The test boundary uses the SDK's ESM parser with native drawing tags substituted.
declare module 'react-native-svg/lib/module/xml.js' {
    export { parse } from 'react-native-svg';
}
