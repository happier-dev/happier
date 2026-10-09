import { createMachineSharingTranslations } from '../machineSharingTranslations.shared';
export const machineSharing = createMachineSharingTranslations({
    terminals: { projectEmpty: 'このプロジェクトでターミナルを開きます。', opening: 'ターミナルを開いています。', sharedOs: 'このターミナルは{machine}のOSユーザーとして実行されます。そのユーザーはローカルの認証情報や暗号化キーを読み取れます。共有作業にはチーム専用のマシンを使用してください。', denied: 'このターミナルへのアクセス権がなくなりました。', rootDenied: 'このワークスペースではターミナルを利用できません。', offline: 'このマシンはオフラインです。最後に取得した出力を表示しています。', openUnknown: 'ターミナルが開かれた可能性があります。再試行する前に既存のターミナルを確認してください。', unavailable: 'このマシンではターミナルを利用できません。', failed: 'このターミナルを開けませんでした。' },
    revoked: '{owner} が {machine} の共有を停止しました。ここで実行中の作業は停止処理中です。セッションは履歴に残りますが、ここで新しい作業は開始できません。',
    recipientEncryptionIncompatible: 'このエンドツーエンド暗号化されたマシンには、エンドツーエンド暗号化されたアカウントが必要です。',
    destinations: { yours: '自分のマシン', created: 'Happier で作成', shared: '共有されたマシン · {team}', owner: '{owner} のマシン · {platform}', pendingKey: '安全なアクセスを準備中', sharedPurposeUnsupported: 'この作業には自分のマシンが必要です。' },
    title: '共有', description: '追加したユーザーやチームは、{machine} のワークスペースでセッションを開始し、スクリプトを実行し、ターミナルを開けます。',
    trustedOs: '{machine} のターミナルやエージェントにアクセスできる人は、あなたのOSユーザーとして操作し、ローカル認証情報や、存在する場合はアカウント暗号化キーを取得できます。Happier API は所有者の認証情報やキーを読み取ったりエクスポートしたりしませんが、共有シェルの出力に含まれる場合があります。チーム専用マシンの共有を推奨します。',
    manageHelp: '{machine} を管理できる人は、他の人にも同じアクセス権を共有できます。', empty: '{machine} を共有して、チームがここで作業できるようにしましょう。',
    loading: '{machine} のアクセス権を読み込んでいます。', readError: '{machine} のアクセス権を読み込めませんでした。', offline: '{machine} はオフラインです。アクセス権の変更はここに保存されます。',
    denied: '{machine} を管理できる人だけが共有を変更できます。', use: '使用可能', manage: '管理可能', allMembers: '現在の全メンバー（後から参加する人も含む）',
    pending: '権限のあるキー保有者が {machine} のアクセスを準備するのを待っています。', incompatible: '{machine} はエンドツーエンド暗号化されていますが、{person} のアカウントは暗号化されていないため、{person} は開けません。',
    incompatibleHelp: '暗号化されていないマシンを共有するか、{person} にアカウント設定でエンドツーエンド暗号化を有効にするよう依頼してください。',
    plain: 'データはエンドツーエンド暗号化されていないため、Home が読み取れます。', saved: '共有を更新しました', yourAccess: '自分のアクセス権',
    ownHistory: 'ここで開始したセッションは Happier ではあなたのものです。{machine} のOSにログインしている人は、そのファイルや出力を閲覧できます。',
    leave: 'この共有から退出', inherited: '{audience} 経由のアクセス権が残っています。管理者に変更を依頼してください。', unavailable: '{machine} のアクセス権を確認できませんでした。',
    effectiveLoss: '最後のアクセス権を失う人のセッション、スクリプト、実行、待機中・準備中の作業、ターミナル、サービスは停止されます。Happier の履歴は本人のものとして残り、取得済みのデータは回収できません。',
    overlap: '他の有効なアクセス権が残っています。作業は継続します。', custodianProtected: '元のマシン所有者はここでは削除・変更できません。',
});
